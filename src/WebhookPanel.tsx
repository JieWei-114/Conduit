import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ConnPill, Empty, LongField, PanelHead, Section, tryJson } from './ui';
import { CopyButton, OutcomeView, type Outcome } from './AttemptLog';
import { downloadJson, fmtBytes, isSensitiveHeader, MASK, maskQuery } from './share';
import { useArmedConfirm } from './useArmedConfirm';

interface Hit {
  id: number;
  at: string;
  method: string;
  path: string;
  rawQuery: string;
  /** decoded; a repeated key appears once per value */
  query: [string, string][];
  /** in arrival order; a repeated header appears once per value */
  headers: [string, string][];
  /** headers whose value was not UTF-8; the value carries a "[not UTF-8, shown lossily]" marker */
  lossyHeaders: string[];
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  bodyLossy: boolean;
  /** reading the body failed part way: only what arrived before that is kept */
  bodyError?: string | null;
  source: string | null;
  response: { status: number; contentType: string; body: string };
  curl: string;
  /** `curl` with credential headers and query values blanked */
  curlMasked?: string;
  bodyBase64?: string | null;
  bodyKeptBytes?: number | null;
  /** the inline cURL commands carry only part of the body; the full ones come from `/api/webhook/curl` */
  curlTruncated?: boolean;
}

async function curlOf(h: Hit, masked: boolean): Promise<string> {
  if (!h.curlTruncated) return masked ? maskedHit(h).curl : h.curl;
  const j = await api(`curl?id=${h.id}&masked=${masked ? 1 : 0}`);
  return j.curl as string;
}

/** A hit safe to paste elsewhere: credential headers and query values blanked. */
function maskedHit(h: Hit): Hit {
  const blank = (pairs: [string, string][]) => pairs.map(([k, v]): [string, string] => [k, isSensitiveHeader(k) ? MASK : v]);
  return {
    ...h,
    headers: blank(h.headers),
    query: blank(h.query),
    rawQuery: maskQuery(h.rawQuery),
    curl: h.curlMasked ?? h.curl,
    curlMasked: undefined,
    bodyBase64: undefined,
  };
}

type Listen = 'idle' | 'connecting' | 'live' | 'error';

/** The JSON a webhook endpoint answered, or why it could not be had. */
async function api(path: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`/api/webhook/${path}`, init);
  } catch (e) {
    throw new Error(`could not reach conduit's backend: ${(e as Error).message || e}`);
  }
  const text = await r.text().catch(() => '');
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`conduit's backend answered ${r.status} ${r.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  if (!r.ok || j?.ok === false) throw new Error(j?.error || `conduit's backend answered ${r.status}`);
  return j;
}

export default function WebhookPanel() {
  const [hits, setHits] = useState<Hit[]>([]);
  const [filter, setFilter] = useState('');
  const [listen, setListen] = useState<{ s: Listen; outcome?: Outcome }>({ s: 'idle' });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [resp, setResp] = useState({ status: '200', contentType: 'application/json', body: '{"ok":true}' });
  const [saveOutcome, setSaveOutcome] = useState<Outcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [dropped, setDropped] = useState(0);
  // the outcome of the last list action (reload, clear) that failed
  const [listOutcome, setListOutcome] = useState<Outcome | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  const clear = useArmedConfirm();

  const captureUrl = `${location.origin}/api/webhook/in/`;

  const loadList = useCallback(async () => {
    const r = await api('list');
    setHits((r.captured ?? []).slice(0, 200));
  }, []);

  // backfill + load canned response on mount
  useEffect(() => {
    const errs: string[] = [];
    Promise.all([
      loadList().catch((e) => errs.push(`Past hits did not load: ${e.message}`)),
      api('config')
        .then((r) => setResp({ status: String(r.status), contentType: r.contentType, body: r.body }))
        .catch((e) => errs.push(`The saved response did not load (the form shows defaults): ${e.message}`)),
    ]).then(() => setLoadErr(errs.join('\n')));
    return () => clearTimeout(savedTimer.current);
  }, [loadList]);

  const stop = () => {
    esRef.current?.close();
    esRef.current = null;
    setListen({ s: 'idle' });
  };

  const connect = () => {
    if (esRef.current) return stop();
    setDropped(0);
    const es = new EventSource('/api/webhook/stream');
    // live only once the server says so: an EventSource that never opens is not listening
    es.addEventListener('ready', () => setListen({ s: 'live' }));
    es.addEventListener('hit', (e) => {
      let rec: Hit;
      try {
        rec = JSON.parse((e as MessageEvent).data) as Hit;
      } catch {
        return; // drop a malformed frame, keep the stream
      }
      setHits((h) => [rec, ...h.filter((x) => x.id !== rec.id)].slice(0, 200));
    });
    es.addEventListener('lagged', (e) => {
      let n = 0;
      try {
        n = Number(JSON.parse((e as MessageEvent).data).dropped) || 0;
      } catch {
        /* count unknown */
      }
      setDropped((d) => d + n);
    });
    es.addEventListener('error', () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
      setListen({
        s: 'error',
        outcome: { ok: false, text: 'The stream from conduit closed. Press Connect to resume; past hits are kept.' },
      });
    });
    esRef.current = es;
    setListen({ s: 'connecting' });
  };
  useEffect(() => () => esRef.current?.close(), []);

  const showSaved = (o: Outcome) => {
    setSaveOutcome(o);
    clearTimeout(savedTimer.current);
    if (o.ok) savedTimer.current = setTimeout(() => setSaveOutcome(null), 1500);
  };

  // the status the canned response would use, or why it is not one
  const statusRaw = resp.status.trim();
  const statusNum = statusRaw === '' ? 200 : Number(statusRaw);
  const statusBad = !Number.isInteger(statusNum) || statusNum < 100 || statusNum > 599;

  const saveResp = async () => {
    if (statusBad || saving) return;
    setSaving(true);
    try {
      const r = await api('config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: statusNum, contentType: resp.contentType, body: resp.body }),
      });
      setResp({ status: String(r.status), contentType: r.contentType, body: r.body });
      showSaved({ ok: true, text: 'Saved' });
    } catch (e) {
      showSaved({ ok: false, text: `Not saved: ${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  const clearAll = async () => {
    clear.disarm();
    try {
      await api('clear', { method: 'POST' });
      setHits([]);
      setExpanded(null);
      setListOutcome(null);
    } catch (e) {
      setListOutcome({ ok: false, text: `Not cleared: ${(e as Error).message}` });
    }
  };

  const reload = () =>
    loadList().then(
      () => {
        setDropped(0);
        setListOutcome(null);
      },
      (e) => setListOutcome({ ok: false, text: `Not reloaded: ${(e as Error).message}` }),
    );

  const fq = filter.trim().toLowerCase();
  const shown = fq
    ? hits.filter(
        (h) =>
          h.path.toLowerCase().includes(fq) ||
          h.method.toLowerCase().includes(fq) ||
          h.body.toLowerCase().includes(fq) ||
          h.rawQuery.toLowerCase().includes(fq) ||
          h.headers.some(([k, v]) => `${k}: ${v}`.toLowerCase().includes(fq)),
      )
    : hits;

  const toggleHit = useCallback((id: number) => setExpanded((e) => (e === id ? null : id)), []);
  const curlExample = `curl -X POST ${captureUrl}hello -H 'content-type: application/json' -d '{"hi":1}'`;
  const live = listen.s === 'live';

  return (
    <div className="layout">
      <div className="left">
        <PanelHead
          title="Webhook"
          badge="inbound capture"
          tagline="Give a service this URL as its callback, and every request it sends shows up on the right."
        />

        <Section title="Capture URL" flush>
          <div className="row row-tight">
            <LongField url className="grow" readOnly value={captureUrl} spellCheck={false} aria-label="Capture URL" onFocus={(e) => e.target.select()} />
            <CopyButton text={captureUrl} label="Copy URL" title="Copy the capture URL" />
          </div>
          <div className="hint">
            Any method and any sub-path is captured, e.g. <code>{captureUrl}payment/callback</code>. Conduit only accepts calls
            from this machine; for a caller elsewhere, expose this port through a tunnel such as ngrok or cloudflared and give
            it the tunnel's URL. Bodies over 10 MB are kept in part and marked truncated.
          </div>
          <div className="inline mt-3">
            {live ? (
              <button className="btn-secondary btn-on" onClick={stop}>
                Disconnect
              </button>
            ) : listen.s === 'connecting' ? (
              <button className="btn-primary" disabled>
                Connecting…
              </button>
            ) : (
              <button className="btn-primary" onClick={connect}>
                Connect
              </button>
            )}
            <ConnPill
              state={listen.s}
              text={live ? 'Connected' : listen.s === 'connecting' ? 'Connecting…' : listen.s === 'error' ? 'Error' : 'Disconnected'}
            />
            <span className="hint m-0">Listens for calls to the capture URL.</span>
          </div>
          {listen.s === 'error' && <OutcomeView o={listen.outcome} secrets={[]} />}
          {dropped > 0 && (
            <div className="error">
              {dropped} hit{dropped === 1 ? '' : 's'} dropped from the live stream because it fell behind.{' '}
              <button className="btn-ghost btn-sm" onClick={reload}>
                Reload the list
              </button>
            </div>
          )}
          <div className="hint">Past hits load either way; connecting streams new ones as they arrive.</div>
          {loadErr && <div className="error" style={{ whiteSpace: 'pre-wrap' }}>{loadErr}</div>}
        </Section>

        <Section title="Canned response" hint="What every captured request gets back.">
          <div className="conn-row mt-0">
            <div className="w-xs">
              <label className="field-first">Status</label>
              <input
                aria-label="Status"
                value={resp.status}
                placeholder="200"
                onChange={(e) => setResp((r) => ({ ...r, status: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && saveResp()}
              />
            </div>
            <div className="grow">
              <label className="field-first">Content type</label>
              <LongField
                value={resp.contentType}
                spellCheck={false}
                placeholder="application/json"
                aria-label="Content type"
                onChange={(v) => setResp((r) => ({ ...r, contentType: v }))}
              />
            </div>
          </div>
          <label>Body</label>
          <textarea
            rows={3}
            value={resp.body}
            spellCheck={false}
            aria-label="Response body"
            placeholder='{"ok":true}'
            onChange={(e) => setResp((r) => ({ ...r, body: e.target.value }))}
          />
          <div className="inline mt-2">
            <button className="btn-secondary" disabled={statusBad || saving} onClick={saveResp}>
              {saving ? 'Saving…' : 'Save response'}
            </button>
            {statusBad && <span className="hint m-0">The status must be a number from 100 to 599.</span>}
          </div>
          <OutcomeView o={saveOutcome} secrets={[]} />
        </Section>
      </div>

      <div className="right">
        {hits.length > 0 && (
          <div className="feed-head mt-0">
            <span className="count">
              {fq ? `${shown.length} / ${hits.length}` : hits.length} hit{hits.length === 1 && !fq ? '' : 's'}
            </span>
            <input
              className="grow"
              placeholder="Filter path, method, query, body or headers"
              aria-label="Filter hits"
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className="btn-ghost btn-sm"
              title="Save every captured request, newest first, as JSON, with credential headers and query values masked"
              onClick={() => downloadJson('webhook', 'hits', hits.map(maskedHit))}
            >
              Export JSON
            </button>
            <button
              className="btn-ghost btn-sm btn-danger"
              title="Discard every captured request, here and in conduit"
              onClick={() => (clear.isArmed('all') ? clearAll() : clear.arm('all'))}
              onMouseLeave={clear.disarm}
              onBlur={clear.disarm}
            >
              {clear.showsArmed('all') ? `Confirm: clear ${hits.length}` : 'Clear'}
            </button>
          </div>
        )}
        <OutcomeView o={listOutcome} secrets={[]} />
        {hits.length === 0 && (
          <Empty
            icon="⇲"
            title="No hits yet"
            hint={
              <>
                {live ? 'Send a request to the capture URL to see it here, ' : <>Press <kbd>Connect</kbd>, then send a request, </>}
                for example:
                <br />
                <code>{curlExample}</code>
              </>
            }
          >
            <CopyButton text={curlExample} label="Copy command" />
          </Empty>
        )}
        <div className="feed">
          {shown.map((h) => (
            <HitRow key={h.id} h={h} open={expanded === h.id} onToggle={toggleHit} />
          ))}
        </div>
      </div>
    </div>
  );
}

const HitRow = memo(function HitRow({
  h,
  open,
  onToggle,
}: {
  h: Hit;
  open: boolean;
  onToggle: (id: number) => void;
}) {
  const pretty = h.bodyTruncated || h.bodyLossy ? null : tryJson(h.body);
  const meta = [
    h.source ? `from ${h.source}` : null,
    `body ${fmtBytes(h.bodyBytes)}`,
    `answered ${h.response.status}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="feed-item">
      <div className="feed-top">
        <span className="feed-ch">
          <b>{h.method}</b> {h.path}
          {h.rawQuery ? <span className="faint">?{h.rawQuery}</span> : null}
        </span>
        <span className="feed-time">{new Date(h.at).toLocaleTimeString()}</span>
      </div>
      <div className="feed-props">{meta}</div>
      {h.query.length > 0 && (
        <div className="feed-props">
          query {h.query.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')}
        </div>
      )}
      {h.bodyError && <div className="error">Body incomplete: {h.bodyError}</div>}
      {(h.bodyTruncated || h.bodyLossy || h.bodyError) && (
        <div className="feed-props">
          {h.bodyTruncated &&
            `Truncated: only the first ${h.bodyKeptBytes != null ? fmtBytes(h.bodyKeptBytes) : '10 MB'} of ${fmtBytes(h.bodyBytes)} were kept. `}
          {h.bodyLossy && 'The body is binary, not UTF-8 text. '}
          The copied cURL replays what is kept, not the original bytes.
        </div>
      )}
      {open && (
        <>
          <div className="feed-msg faint">
            {h.headers.map(([k, v], i) => (
              <div key={i}>
                {k}: {isSensitiveHeader(k) ? MASK : v}
              </div>
            ))}
          </div>
          <div className="feed-props">
            response sent: {h.response.status} · {h.response.contentType}
          </div>
          {h.response.body && <div className="feed-msg faint">{h.response.body}</div>}
        </>
      )}
      {h.body && (h.bodyLossy ? <BinaryBody h={h} /> : <div className="feed-msg">{pretty ?? h.body}</div>)}
      <div className="feed-actions">
        <button className={`btn-ghost btn-sm ${open ? 'btn-on' : ''}`} aria-pressed={open} onClick={() => onToggle(h.id)} title="Headers and the response sent">
          Details
        </button>
        {h.body && <CopyButton text={h.body} label="Copy body" />}
        <CopyButton
          text={() => JSON.stringify(maskedHit(h), null, 2)}
          label="Copy as JSON"
          title="The whole captured request and the response sent, as JSON, with credential headers and query values masked"
        />
        <CopyButton
          text={() => curlOf(h, true)}
          label="Copy as cURL"
          title="A cURL command that sends this request again, with credential headers and query values masked"
        />
        <CopyButton
          text={() => curlOf(h, false)}
          label="Copy with secrets"
          title="The cURL command exactly as received, credentials included"
        />
      </div>
    </div>
  );
});

const PREVIEW_BYTES = 4096;

function b64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const txt = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${txt}`);
  }
  return lines.join('\n');
}

function BinaryBody({ h }: { h: Hit }) {
  const [view, setView] = useState<'hex' | 'base64' | 'text'>('hex');
  const bytes = h.bodyBase64 ? b64ToBytes(h.bodyBase64) : null;
  const preview = bytes ? bytes.subarray(0, PREVIEW_BYTES) : null;
  const shown =
    view === 'text' || !preview
      ? h.body
      : view === 'hex'
        ? hexDump(preview)
        : btoa(String.fromCharCode(...preview));
  const views = (bytes ? ['hex', 'base64', 'text'] : ['text']) as ('hex' | 'base64' | 'text')[];
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <div className="inline">
        <span className="feed-props m-0">
          binary body · {fmtBytes(h.bodyBytes)}
          {bytes && bytes.length > PREVIEW_BYTES ? ` · first ${fmtBytes(PREVIEW_BYTES)} shown` : ''}
        </span>
        {bytes ? (
          <div className="seg seg-sm" role="group" aria-label="Body view">
            {views.map((v) => (
              <button
                type="button"
                key={v}
                className={view === v ? 'on' : ''}
                aria-pressed={view === v}
                title={v === 'text' ? 'As text, with bytes that are not UTF-8 replaced' : undefined}
                onClick={() => setView(v)}
              >
                {v}
              </button>
            ))}
          </div>
        ) : (
          <button className={`btn-ghost btn-sm ${open ? 'btn-on' : ''}`} aria-pressed={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide lossy text' : 'Show lossy text'}
          </button>
        )}
      </div>
      {(bytes || open) && <div className="feed-msg mono">{shown}</div>}
    </div>
  );
}
