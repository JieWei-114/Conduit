import { useState } from 'react';
import { Empty, LongField, PanelHead } from './ui';
import { CopyButton } from './AttemptLog';
import { useExample } from './examples';
import RecipeEditor from './RecipeEditor';

// ── tiny helpers ────────────────────────────────────────────────────────────
const b64utf8 = (s: string) => btoa(unescape(encodeURIComponent(s)));

/** Bytes from standard Base64 or base64url (`-`/`_`), with or without `=` padding; whitespace ignored. */
function b64bytes(input: string): Uint8Array {
  let s = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    const bad = s.match(/[^A-Za-z0-9+/=]/)?.[0];
    throw new Error(bad ? `not Base64: unexpected character "${bad}"` : 'not Base64: "=" padding only belongs at the end');
  }
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Error('not Base64: the length is one character too long or too short');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function unb64utf8(s: string): string {
  const bytes = b64bytes(s);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`valid Base64, but the ${bytes.length} decoded bytes are not UTF-8 text. Hex: ${toHexBytes(bytes)}`);
  }
}

function toHexBytes(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}
function toHex(s: string): string {
  return toHexBytes(new TextEncoder().encode(s));
}
function fromHex(s: string): string {
  const clean = s.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (!/^[0-9a-f]*$/i.test(clean)) throw new Error(`not hex: unexpected character "${clean.match(/[^0-9a-f]/i)?.[0]}"`);
  if (clean.length % 2) throw new Error('odd number of hex digits');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('valid hex, but the bytes are not UTF-8 text');
  }
}

/** A lone surrogate (half an emoji, say) has no UTF-8 form: name it instead of a bare URIError. */
function utf8Guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof URIError) throw new Error(`${e.message}: the text has a lone surrogate (half a character), or a malformed %-escape`);
    throw e;
  }
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function describeField(f: string, unit: string, names?: string[]): string {
  if (f === '*') return `every ${unit}`;
  const named = (n: string) => (names && names[+n] ? names[+n] : n);
  if (/^\*\/\d+$/.test(f)) return `every ${f.slice(2)} ${unit}s`;
  if (/^\d+-\d+$/.test(f)) {
    const [a, b] = f.split('-');
    return `${unit}s ${named(a)}–${named(b)}`;
  }
  if (/^[\d,]+$/.test(f)) return `${unit} ${f.split(',').map(named).join(', ')}`;
  return `${unit} ${f}`;
}
function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) throw new Error(`Expected 5 fields (minute, hour, day-of-month, month, day-of-week), got ${p.length}.`);
  const [mi, ho, dom, mo, dow] = p;
  const parts = [
    describeField(mi, 'minute'),
    describeField(ho, 'hour'),
    dom === '*' ? '' : describeField(dom, 'day-of-month'),
    mo === '*' ? '' : describeField(mo, 'month', MON),
    dow === '*' ? '' : describeField(dow, 'weekday', DOW),
  ].filter(Boolean);
  return parts.join(' · ');
}

function browserNow(): number {
  return Date.now();
}
/** The output of `fn` for `input`, or why there is none. */
interface Out {
  value: string;
  error?: string;
}
function safe(fn: () => string, input: string): Out {
  if (!input.trim()) return { value: '' };
  try {
    return { value: fn() };
  } catch (e) {
    return { value: '', error: (e as Error).message || String(e) };
  }
}

/** An output with its Copy button, or why there is none (shown as an error, never copied). */
function CopyOut({ value, error }: { value: string; error?: string }) {
  if (error) return <div className="error">{error}</div>;
  if (!value) return null;
  return (
    <div className="util-out">
      <pre>{value}</pre>
      <CopyButton text={value} />
    </div>
  );
}

type Tool = 'recipe' | 'base64' | 'hex' | 'url' | 'json' | 'time' | 'cron' | 'uuid';
const NAV: { id: Tool; label: string; desc: string }[] = [
  { id: 'recipe', label: 'Recipe', desc: 'Chain steps such as encode, hash, sign or encrypt. Each step takes the previous output, and runs as you edit.' },
  { id: 'base64', label: 'Base64', desc: 'Encode text to Base64 and decode Base64 back to text, UTF-8 safe.' },
  { id: 'hex', label: 'Hex', desc: 'Convert text to space-separated hex bytes and back.' },
  { id: 'url', label: 'URL encode', desc: 'Percent-encode or decode a query string value or path segment.' },
  { id: 'json', label: 'JSON format', desc: 'Pretty-print JSON with 2-space indent, or minify it to one line.' },
  { id: 'time', label: 'Timestamp', desc: 'Translate a Unix timestamp into ISO and local time, and back again.' },
  { id: 'cron', label: 'Cron explainer', desc: 'Read a 5-field cron expression back as plain English.' },
  { id: 'uuid', label: 'UUID v4', desc: 'Generate throwaway random UUIDs for test data and fixtures.' },
];

export default function UtilsPanel() {
  const [sel, setSel] = useState<Tool>('recipe');
  const [starter, setStarter] = useState<{ id: string; n: number } | null>(null);
  useExample<{ template: string }>('utils', (d) => {
    setSel('recipe');
    setStarter((s) => ({ id: d.template, n: (s?.n ?? 0) + 1 }));
  });
  const [b64in, setB64in] = useState('');
  const [hexin, setHexin] = useState('');
  const [urlin, setUrlin] = useState('');
  const [jsonin, setJsonin] = useState('');
  const [ts, setTs] = useState('');
  const [cron, setCron] = useState('');
  const [uuids, setUuids] = useState<string[]>([]);

  const tsOut = safe(() => {
    const t = ts.trim();
    const n = Number(t);
    if (!Number.isNaN(n)) {
      const ms = t.length > 10 ? n : n * 1000;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) throw new Error(`${t} is out of the range a date can hold.`);
      return `ISO   ${d.toISOString()}\nlocal ${d.toLocaleString()}\nunix  ${Math.floor(ms / 1000)} s · ${ms} ms`;
    }
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) throw new Error('Not a number or a date this browser can read, e.g. 1700000000 or 2026-08-17T10:00:00Z.');
    return `unix  ${Math.floor(d.getTime() / 1000)} s · ${d.getTime()} ms\nISO   ${d.toISOString()}`;
  }, ts);

  const title = (id: Tool) => {
    const n = NAV.find((x) => x.id === id)!;
    return <PanelHead title={n.label} tagline={n.desc} />;
  };

  return (
    <div className="navlay">
      <div className="navlist">
        <div className="navlist-label">Tools</div>
        {NAV.map((n) => (
          <button
            type="button"
            key={n.id}
            className={`navitem ${sel === n.id ? 'active' : ''}`}
            aria-pressed={sel === n.id}
            onClick={() => setSel(n.id)}
          >
            {n.label}
          </button>
        ))}
      </div>

      <div className="navcontent">
        <div className="navcontent-inner">
        {sel === 'recipe' && (
          <>
            {title('recipe')}
            <RecipeEditor starter={starter} />
          </>
        )}

        {sel === 'base64' && (
          <>
            {title('base64')}
            <textarea rows={3} value={b64in} spellCheck={false} aria-label="Text or Base64" placeholder="text or base64…" onChange={(e) => setB64in(e.target.value)} />
            {b64in.trim() ? (
              <>
                <label>Encoded</label>
                <CopyOut {...safe(() => utf8Guard(() => b64utf8(b64in)), b64in)} />
                <label>Decoded</label>
                <div className="hint">Standard Base64 or base64url (<code className="mono">-</code>/<code className="mono">_</code>), padding optional.</div>
                <CopyOut {...safe(() => unb64utf8(b64in), b64in)} />
              </>
            ) : (
              <Empty icon="⇄" title="No input yet" hint="Paste text or a Base64 string above. Both directions are computed as you type." />
            )}
          </>
        )}

        {sel === 'hex' && (
          <>
            {title('hex')}
            <textarea rows={3} value={hexin} spellCheck={false} aria-label="Text or hex" placeholder="text, or: 68 65 6c 6c 6f" onChange={(e) => setHexin(e.target.value)} />
            {hexin.trim() ? (
              <>
                <label>Text as hex</label>
                <CopyOut {...safe(() => toHex(hexin), hexin)} />
                <label>Hex as text</label>
                <div className="hint">Accepts spaces, commas and <code className="mono">0x</code> prefixes.</div>
                <CopyOut {...safe(() => fromHex(hexin), hexin)} />
              </>
            ) : (
              <Empty icon="⇄" title="No input yet" hint="Type text to see its bytes, or paste hex bytes to read them back as text." />
            )}
          </>
        )}

        {sel === 'url' && (
          <>
            {title('url')}
            <textarea rows={3} value={urlin} spellCheck={false} aria-label="Value to encode or decode" placeholder="value with spaces & symbols…" onChange={(e) => setUrlin(e.target.value)} />
            {urlin.trim() ? (
              <>
                <label>Encoded</label>
                <div className="hint">Percent-encoded with <code className="mono">encodeURIComponent</code>, safe for a query value.</div>
                <CopyOut {...safe(() => utf8Guard(() => encodeURIComponent(urlin)), urlin)} />
                <label>Decoded</label>
                <CopyOut {...safe(() => utf8Guard(() => decodeURIComponent(urlin)), urlin)} />
              </>
            ) : (
              <Empty icon="⇄" title="No input yet" hint="Paste a raw value or an already-encoded one. Both directions are computed as you type." />
            )}
          </>
        )}

        {sel === 'json' && (
          <>
            {title('json')}
            <textarea rows={6} value={jsonin} spellCheck={false} aria-label="JSON" placeholder='{"a":1,"b":[2,3]}' onChange={(e) => setJsonin(e.target.value)} />
            {jsonin.trim() ? (
              <>
                <label>Pretty</label>
                <CopyOut {...safe(() => JSON.stringify(JSON.parse(jsonin), null, 2), jsonin)} />
                <label>Minified</label>
                <CopyOut {...safe(() => JSON.stringify(JSON.parse(jsonin)), jsonin)} />
              </>
            ) : (
              <Empty icon="{ }" title="No JSON yet" hint="Paste a JSON object or array above to get an indented and a one-line version." />
            )}
          </>
        )}

        {sel === 'time' && (
          <>
            {title('time')}
            <label>Timestamp or date</label>
            <LongField value={ts} spellCheck={false} aria-label="Timestamp or date" placeholder="1700000000  ·  or  2026-08-17T10:00:00Z" onChange={setTs} />
            <div className="hint">Ten digits are read as seconds, thirteen as milliseconds.</div>
            <div className="inline mt-2">
              <button className="btn-secondary btn-sm" onClick={() => setTs(String(Math.floor(browserNow() / 1000)))}>Now (s)</button>
              <button className="btn-secondary btn-sm" onClick={() => setTs(String(browserNow()))}>Now (ms)</button>
            </div>
            {ts.trim() ? (
              <div className="mt-3">
                <CopyOut {...tsOut} />
              </div>
            ) : (
              <Empty
                icon="⏱"
                title="No timestamp yet"
                hint={<>Enter a Unix timestamp such as 1700000000 or an ISO date, or press <kbd>Now (s)</kbd> to start from the current time.</>}
              />
            )}
          </>
        )}

        {sel === 'cron' && (
          <>
            {title('cron')}
            <label>Expression</label>
            <LongField value={cron} spellCheck={false} aria-label="Cron expression" placeholder="*/5 9-17 * * 1-5" onChange={setCron} />
            <div className="hint">Five fields, in order: minute, hour, day-of-month, month, day-of-week.</div>
            {cron.trim() ? (
              <div className="mt-3">
                <CopyOut {...safe(() => describeCron(cron), cron)} />
              </div>
            ) : (
              <Empty icon="⏲" title="No expression yet" hint="Enter a 5-field cron expression above to read back the schedule it describes." />
            )}
          </>
        )}

        {sel === 'uuid' && (
          <>
            {title('uuid')}
            <div className="hint mb-2">From <code className="mono">crypto.randomUUID()</code>, the browser's cryptographically secure generator.</div>
            <div className="inline">
              <button className="btn-primary" onClick={() => setUuids((u) => [crypto.randomUUID(), ...u].slice(0, 20))}>Generate</button>
              {uuids.length > 0 && (
                <button className="btn-ghost btn-danger" onClick={() => setUuids([])}>Clear</button>
              )}
            </div>
            {uuids.length > 0 ? (
              <div className="mt-3">
                <CopyOut value={uuids.join('\n')} />
              </div>
            ) : (
              <Empty icon="⌗" title="No UUIDs yet" hint={<>Press <kbd>Generate</kbd> for a fresh v4 UUID. The last 20 are kept so you can copy them as a block.</>} />
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
