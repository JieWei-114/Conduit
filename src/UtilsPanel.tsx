import { useState } from 'react';

// ── tiny helpers ────────────────────────────────────────────────────────────
const b64utf8 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const unb64utf8 = (s: string) => decodeURIComponent(escape(atob(s.trim())));

function toHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}
function fromHex(s: string): string {
  const clean = s.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (clean.length % 2) throw new Error('odd number of hex digits');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function uuidv4(): string {
  const h = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += h[8 + Math.floor(Math.random() * 4)];
    else out += h[Math.floor(Math.random() * 16)];
  }
  return out;
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
  if (p.length !== 5) return '⚠ expected 5 fields: minute hour day-of-month month day-of-week';
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
function safe(fn: () => string, input: string, showErr = false): string {
  if (!input.trim()) return '';
  try {
    return fn();
  } catch (e) {
    return showErr ? `⚠ ${(e as Error).message}` : '';
  }
}

function CopyOut({ value }: { value: string }) {
  if (!value) return null;
  return (
    <div className="util-out">
      <pre>{value}</pre>
      <span className="chip" onClick={() => navigator.clipboard.writeText(value)}>copy</span>
    </div>
  );
}

type Tool = 'base64' | 'hex' | 'url' | 'json' | 'time' | 'cron' | 'uuid';
const NAV: { id: Tool; label: string }[] = [
  { id: 'base64', label: 'Base64' },
  { id: 'hex', label: 'Hex' },
  { id: 'url', label: 'URL encode' },
  { id: 'json', label: 'JSON format' },
  { id: 'time', label: 'Timestamp' },
  { id: 'cron', label: 'Cron explainer' },
  { id: 'uuid', label: 'UUID v4' },
];

export default function UtilsPanel() {
  const [sel, setSel] = useState<Tool>('base64');
  const [b64in, setB64in] = useState('');
  const [hexin, setHexin] = useState('');
  const [urlin, setUrlin] = useState('');
  const [jsonin, setJsonin] = useState('');
  const [ts, setTs] = useState('');
  const [cron, setCron] = useState('');
  const [uuids, setUuids] = useState<string[]>([]);

  const tsOut = (() => {
    const t = ts.trim();
    if (!t) return '';
    const n = Number(t);
    if (!Number.isNaN(n) && t !== '') {
      const ms = t.length > 10 ? n : n * 1000;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return '⚠ invalid';
      return `ISO   ${d.toISOString()}\nlocal ${d.toLocaleString()}\nunix  ${Math.floor(ms / 1000)} s · ${ms} ms`;
    }
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return '⚠ not a number or parseable date';
    return `unix  ${Math.floor(d.getTime() / 1000)} s · ${d.getTime()} ms\nISO   ${d.toISOString()}`;
  })();

  return (
    <div className="navlay">
      <div className="navlist">
        {NAV.map((n) => (
          <div key={n.id} className={`navitem ${sel === n.id ? 'active' : ''}`} onClick={() => setSel(n.id)}>
            {n.label}
          </div>
        ))}
      </div>

      <div className="navcontent">
        {sel === 'base64' && (
          <>
            <div className="util-title">Base64</div>
            <textarea rows={3} value={b64in} spellCheck={false} placeholder="text or base64…" onChange={(e) => setB64in(e.target.value)} />
            <label>encode →</label>
            <CopyOut value={safe(() => b64utf8(b64in), b64in)} />
            <label>decode →</label>
            <CopyOut value={safe(() => unb64utf8(b64in), b64in)} />
          </>
        )}

        {sel === 'hex' && (
          <>
            <div className="util-title">Hex</div>
            <textarea rows={3} value={hexin} spellCheck={false} placeholder="text, or: 68 65 6c 6c 6f" onChange={(e) => setHexin(e.target.value)} />
            <label>text → hex</label>
            <CopyOut value={safe(() => toHex(hexin), hexin)} />
            <label>hex → text</label>
            <CopyOut value={safe(() => fromHex(hexin), hexin, true)} />
          </>
        )}

        {sel === 'url' && (
          <>
            <div className="util-title">URL encode / decode</div>
            <textarea rows={3} value={urlin} spellCheck={false} placeholder="value with spaces & symbols…" onChange={(e) => setUrlin(e.target.value)} />
            <label>encodeURIComponent →</label>
            <CopyOut value={safe(() => encodeURIComponent(urlin), urlin)} />
            <label>decodeURIComponent →</label>
            <CopyOut value={safe(() => decodeURIComponent(urlin), urlin, true)} />
          </>
        )}

        {sel === 'json' && (
          <>
            <div className="util-title">JSON format / minify</div>
            <textarea rows={6} value={jsonin} spellCheck={false} placeholder='{"a":1,"b":[2,3]}' onChange={(e) => setJsonin(e.target.value)} />
            <label>pretty →</label>
            <CopyOut value={safe(() => JSON.stringify(JSON.parse(jsonin), null, 2), jsonin, true)} />
            <label>minify →</label>
            <CopyOut value={safe(() => JSON.stringify(JSON.parse(jsonin)), jsonin, true)} />
          </>
        )}

        {sel === 'time' && (
          <>
            <div className="util-title">Unix timestamp ↔ date</div>
            <input value={ts} spellCheck={false} placeholder="1700000000  ·  or  2026-08-17T10:00:00Z" onChange={(e) => setTs(e.target.value)} />
            <div className="row field-row" style={{ marginTop: 8 }}>
              <span className="chip" onClick={() => setTs(String(Math.floor(browserNow() / 1000)))}>now (s)</span>
              <span className="chip" onClick={() => setTs(String(browserNow()))}>now (ms)</span>
            </div>
            <CopyOut value={tsOut} />
          </>
        )}

        {sel === 'cron' && (
          <>
            <div className="util-title">Cron explainer</div>
            <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>standard 5-field: minute hour day-of-month month day-of-week</div>
            <input value={cron} spellCheck={false} placeholder="*/5 9-17 * * 1-5" onChange={(e) => setCron(e.target.value)} />
            <CopyOut value={cron.trim() ? describeCron(cron) : ''} />
          </>
        )}

        {sel === 'uuid' && (
          <>
            <div className="util-title">UUID v4</div>
            <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>scratchpad generator — not for cryptographic use</div>
            <div className="row field-row">
              <button style={{ width: 'auto' }} onClick={() => setUuids((u) => [uuidv4(), ...u].slice(0, 20))}>generate</button>
              {uuids.length > 0 && <span className="chip" onClick={() => setUuids([])}>clear</span>}
            </div>
            {uuids.length > 0 && <CopyOut value={uuids.join('\n')} />}
          </>
        )}
      </div>
    </div>
  );
}
