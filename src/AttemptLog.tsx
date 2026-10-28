import { memo, useEffect, useMemo, useRef, useState } from 'react';
import JsonTree from './JsonTree';
import { maskDeep, maskHeaders, maskUrl } from './share';
import type { AttemptError, AttemptLog } from './types';

export function shareableLog(log: AttemptLog, secrets: string[]): AttemptLog {
  const blank = (h?: Record<string, string> | null) => (h ? maskHeaders(h) : h);
  const copy: AttemptLog = {
    ...log,
    url: typeof log.url === 'string' ? maskUrl(log.url) : log.url,
    request: { ...log.request, headers: blank(log.request.headers) ?? {} },
    response: log.response ? { ...log.response, headers: blank(log.response.headers) ?? {} } : log.response,
  };
  return maskDeep(copy, secrets) as AttemptLog;
}

const KIND_LABEL: Record<string, string> = {
  dns: 'Name did not resolve',
  connect: 'Could not connect',
  tls: 'TLS failed',
  protocol: 'Connection closed',
  timeout: 'Timed out',
  body: 'Reply cut off',
  request: 'Not sent',
  network: 'Network error',
  http: 'Server refused',
  database: 'Database error',
  reply: 'Server replied with an error',
};

const DAY = 86400;

function relDays(secs: number): string {
  const d = Math.round(Math.abs(secs) / DAY);
  if (d === 0) return 'today';
  return secs < 0 ? `${d} day${d === 1 ? '' : 's'} ago` : `in ${d} day${d === 1 ? '' : 's'}`;
}

/** Error text for a person: URL secrets masked, certificate times as dates instead of UNIX seconds. */
export function readableTimes(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s()]+/gi, (u) => maskUrl(u))
    .replace(/\b(\d{9,11}) \(UNIX\)/g, (_, n: string) => {
      const d = new Date(Number(n) * 1000);
      return Number.isNaN(d.getTime()) ? n : `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    })
    .replace(/\((\d+) seconds ago\)/g, (_, n: string) => `(${relDays(-Number(n))})`)
    .replace(/\((\d+) seconds from now\)/g, (_, n: string) => `(${relDays(Number(n))})`);
}

function addrLine(a: { address: string; ok: boolean; ms: number; error?: string }): string {
  return `${a.address} ${a.ok ? '✓ accepts connections' : `✗ ${a.error ?? ''}`} (${a.ms} ms)`;
}

export const FailureDetail = memo(function FailureDetail({ detail }: { detail: AttemptError }) {
  const dns = detail.probe?.dns;
  type Tcp = { address: string; ok: boolean; ms: number; error?: string };
  const raw = detail.probe as { tcp?: Tcp | Tcp[] | null; tcpAll?: Tcp[] } | null | undefined;
  const tcpAll = Array.isArray(raw?.tcp) ? raw.tcp : raw?.tcpAll;
  const tcp = Array.isArray(raw?.tcp) ? raw.tcp[0] : raw?.tcp;
  const chain = detail.chain.filter((c) => c.trim() !== detail.message.trim());
  const dnsError = dns?.error && !detail.message.includes(dns.error) ? dns.error : 'did not resolve';
  return (
    <div className="failure">
      <div className="failure-head">
        <span className="break">{readableTimes(detail.message)}</span>
      </div>
      {detail.hints.length > 0 && (
        <ul className="failure-hints">
          {detail.hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {chain.length > 0 && (
        <>
          <div className="block-label">Cause, outermost first</div>
          <ol className="failure-chain">
            {chain.map((c, i) => (
              <li key={i} className="break">
                {readableTimes(c)}
              </li>
            ))}
          </ol>
        </>
      )}
      {detail.probe && !detail.probe.error && (
        <>
          <div className="block-label">Probe</div>
          <table className="rtable kv-table">
            <tbody>
              <tr>
                <td>DNS</td>
                <td>
                  {detail.probe.host}
                  {dns?.ok ? ` → ${dns.addresses?.join(', ')}` : ` ✗ ${dnsError}`}
                  {dns ? ` (${dns.ms} ms)` : ''}
                </td>
              </tr>
              <tr>
                <td>TCP</td>
                <td>
                  {Array.isArray(tcpAll) && tcpAll.length > 0
                    ? tcpAll.map((a) => <div key={a.address}>{addrLine(a)}</div>)
                    : tcp
                      ? addrLine(tcp)
                      : 'not tried (no address)'}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
});

/** The record of one request: a toggle to read it as a tree, and a button to copy it as JSON. */
export function AttemptLogBar({
  log,
  secrets,
  open: openProp,
  onOpenChange,
}: {
  log?: AttemptLog | null;
  secrets: string[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openOwn, setOpenOwn] = useState(false);
  const open = openProp ?? openOwn;
  const setOpen = (f: (o: boolean) => boolean) => {
    const next = f(open);
    setOpenOwn(next);
    onOpenChange?.(next);
  };
  const [copied, copy] = useCopy();
  const shown = useMemo(() => (log ? shareableLog(log, secrets) : null), [log, secrets]);
  if (!log || !shown) return null;
  return (
    <>
      <button
        type="button"
        className={`btn-ghost btn-sm ${open ? 'btn-on' : ''}`}
        aria-pressed={open}
        title="Everything about this request: what was sent, when, what came back, timing and bytes"
        onClick={() => setOpen((o) => !o)}
      >
        Log
      </button>
      <button
        type="button"
        className="btn-ghost btn-sm"
        title="Copy the record as JSON, with credentials and secret values masked"
        onClick={() => copy(JSON.stringify(shown, null, 2))}
      >
        {copied ?? 'Copy as log'}
      </button>
      {open && (
        <div className="attempt-log">
          <JsonTree data={shown} />
        </div>
      )}
    </>
  );
}

/** What one operation came to, as every panel shows it. */
export interface Outcome {
  ok: boolean;
  /** done, but not everything went through */
  warn?: boolean;
  /** still running: `text` says what it is doing */
  busy?: boolean;
  /** on success what it did ("PONG", "3 topics"); on failure the error when there is no `detail` */
  text?: string;
  ms?: number;
  detail?: AttemptError | null;
  log?: AttemptLog | null;
}

/**
 * An operation's result, laid out the same in every panel: a status line (done or failed, and how
 * long it took), the record's Log bar, then why it failed — the full explanation when the server
 * gave one, else the error text. Nothing is shown twice.
 */
export const OutcomeView = memo(function OutcomeView({ o, secrets }: { o?: Outcome | null; secrets: string[] }) {
  if (!o) return null;
  const failedAs = o.detail ? (KIND_LABEL[o.detail.kind] ?? 'Failed') : 'Failed';
  return (
    <div className="outcome">
      <div className={`status status-sm ${o.busy ? 'busy' : o.ok ? (o.warn ? 'warn' : 'ok') : 'bad'}`} role="status">
        <span className="break">{o.busy ? o.text || 'Working…' : o.ok ? o.text || 'Done' : failedAs}</span>
        {o.ms != null && (
          <>
            <span className="sep">·</span>
            <span>{o.ms} ms</span>
          </>
        )}
      </div>
      {!o.ok && (o.detail ? <FailureDetail detail={o.detail} /> : o.text ? <div className="error break">{o.text}</div> : null)}
      {o.log && (
        <div className="result-bar">
          <AttemptLogBar log={o.log} secrets={secrets} />
        </div>
      )}
    </div>
  );
});

/**
 * Copy text with feedback on the button itself: returns the label to show for 1.5 s ("Copied" or
 * "Copy failed", `null` otherwise) and the function that copies.
 */
export function useCopy(): [string | null, (text: string | Promise<string>) => void] {
  const [label, setLabel] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const show = (text: string) => {
    setLabel(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel(null), 1500);
  };
  const copy = (text: string | Promise<string>) => {
    if (!navigator.clipboard) return show('Copy failed');
    const write =
      typeof text === 'string'
        ? navigator.clipboard.writeText(text)
        : typeof ClipboardItem !== 'undefined'
          ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })])
          : text.then((t) => navigator.clipboard.writeText(t));
    write.then(
      () => show('Copied'),
      () => show('Copy failed'),
    );
  };
  return [label, copy];
}

/** A button that copies `text` and says whether it worked. */
export function CopyButton({ text, label = 'Copy', title }: { text: string | (() => string | Promise<string>); label?: string; title?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      className="btn-ghost btn-sm"
      title={title}
      onClick={() => copy(typeof text === 'function' ? text() : text)}
    >
      {copied ?? label}
    </button>
  );
}

