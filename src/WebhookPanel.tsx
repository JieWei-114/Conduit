import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ConnPill, Empty, PanelHead, Section, tryJson } from './ui';
import { useFlash } from './useFlash';

interface Hit {
  id: number;
  at: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}


export default function WebhookPanel() {
  const [hits, setHits] = useState<Hit[]>([]);
  const [filter, setFilter] = useState('');
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [resp, setResp] = useState({ status: '200', contentType: 'application/json', body: '{"ok":true}' });
  const [savedMsg, setSavedMsg] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const [flashMsg, flash] = useFlash();

  const captureUrl = `${location.origin}/api/webhook/in/`;

  // backfill + load canned response on mount
  useEffect(() => {
    fetch('/api/webhook/list')
      .then((r) => r.json())
      .then((r) => r.ok && setHits((r.captured ?? []).slice(0, 200)))
      .catch(() => {});
    fetch('/api/webhook/config')
      .then((r) => r.json())
      .then((r) => r.ok && setResp({ status: String(r.status), contentType: r.contentType, body: r.body }))
      .catch(() => {});
  }, []);

  const connect = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
      setLive(false);
      return;
    }
    const es = new EventSource('/api/webhook/stream');
    es.addEventListener('ready', () => setLive(true));
    es.addEventListener('hit', (e) => {
      let rec: Hit;
      try { rec = JSON.parse((e as MessageEvent).data) as Hit; } catch { return; } // drop malformed frame, keep stream
      setHits((h) => [rec, ...h].slice(0, 200));
    });
    es.addEventListener('error', () => {
      setLive(false);
      es.close();
      esRef.current = null;
    });
    esRef.current = es;
    setLive(true);
  };
  useEffect(() => () => esRef.current?.close(), []);

  const saveResp = async () => {
    const r = await fetch('/api/webhook/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: Number(resp.status) || 200, contentType: resp.contentType, body: resp.body }),
    }).then((x) => x.json());
    setSavedMsg(r.ok ? 'Saved' : 'Could not save');
    setTimeout(() => setSavedMsg(''), 1500);
  };

  const clearAll = async () => {
    await fetch('/api/webhook/clear', { method: 'POST' }).catch(() => {});
    setHits([]);
  };

  const fq = filter.trim().toLowerCase();
  const shown = fq
    ? hits.filter(
        (h) =>
          h.path.toLowerCase().includes(fq) ||
          h.method.toLowerCase().includes(fq) ||
          h.body.toLowerCase().includes(fq) ||
          JSON.stringify(h.headers).toLowerCase().includes(fq),
      )
    : hits;

  const toggleHit = useCallback((id: number) => setExpanded((e) => (e === id ? null : id)), []);
  const curlExample = `curl -X POST ${captureUrl}hello -H 'content-type: application/json' -d '{"hi":1}'`;

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
            <input className="grow" readOnly value={captureUrl} spellCheck={false} aria-label="Capture URL" onFocus={(e) => e.target.select()} />
            <button
              className="btn-secondary"
              title="Copy the capture URL"
              onClick={() => navigator.clipboard.writeText(captureUrl).then(() => flash('Capture URL copied'))}
            >
              Copy
            </button>
          </div>
          <div className="hint">
            Any method and any sub-path is captured, e.g. <code>{captureUrl}payment/callback</code>. Use this machine's LAN IP
            instead of localhost when the caller is another machine.
          </div>
          <div className="inline mt-3">
            <button className={live ? 'btn-secondary btn-on' : 'btn-primary'} onClick={connect}>
              {live ? 'Stop listening' : 'Start listening'}
            </button>
            <ConnPill state={live ? 'live' : 'idle'} text={live ? 'Listening' : 'Not listening'} />
          </div>
          <div className="hint">Past hits load either way; listening streams new ones as they arrive.</div>
          {flashMsg && <div className="toast">{flashMsg}</div>}
        </Section>

        <Section title="Canned response" hint="What every captured request gets back.">
          <div className="conn-row mt-0">
            <div className="w-xs">
              <label className="field-first">Status</label>
              <input value={resp.status} placeholder="200" onChange={(e) => setResp((r) => ({ ...r, status: e.target.value }))} />
            </div>
            <div className="grow">
              <label className="field-first">Content type</label>
              <input
                value={resp.contentType}
                spellCheck={false}
                placeholder="application/json"
                onChange={(e) => setResp((r) => ({ ...r, contentType: e.target.value }))}
              />
            </div>
          </div>
          <label>Body</label>
          <textarea rows={3} value={resp.body} spellCheck={false} placeholder='{"ok":true}' onChange={(e) => setResp((r) => ({ ...r, body: e.target.value }))} />
          <div className="inline mt-2">
            <button className="btn-secondary" onClick={saveResp}>
              Save response
            </button>
            {savedMsg && <span className="toast m-0">{savedMsg}</span>}
          </div>
        </Section>
      </div>

      <div className="right">
        {hits.length > 0 && (
          <div className="feed-head mt-0">
            <span className="count">{fq ? `${shown.length} / ${hits.length}` : hits.length} hits</span>
            <input
              className="grow"
              placeholder="Filter path, method, body or headers"
              aria-label="Filter hits"
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button className="btn-ghost btn-sm" title="Discard every captured request" onClick={clearAll}>
              Clear
            </button>
          </div>
        )}
        {hits.length === 0 && (
          <Empty
            icon="⇲"
            title={live ? 'Listening, no hits yet' : 'Not listening'}
            hint={
              <>
                {live ? 'Send a request to the capture URL to see it here, ' : 'Press Start listening, then send a request, '}
                for example:
                <br />
                <code>{curlExample}</code>
              </>
            }
          >
            <button
              className="btn-secondary btn-sm"
              onClick={() => navigator.clipboard.writeText(curlExample).then(() => flash('Example command copied'))}
            >
              Copy this command
            </button>
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

const HitRow = memo(function HitRow({ h, open, onToggle }: { h: Hit; open: boolean; onToggle: (id: number) => void }) {
  const pretty = tryJson(h.body);
  return (
    <div className="feed-item">
      <div className="feed-top">
        <span className="feed-ch">
          <b>{h.method}</b> {h.path}
        </span>
        <span className="feed-time">{new Date(h.at).toLocaleTimeString()}</span>
      </div>
      {Object.keys(h.query).length > 0 && <div className="feed-props">query {JSON.stringify(h.query)}</div>}
      {open && (
        <div className="feed-msg faint">
          {Object.entries(h.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')}
        </div>
      )}
      {h.body && <div className="feed-msg">{pretty ?? h.body}</div>}
      <div className="feed-actions">
        <button className={`btn-ghost btn-sm ${open ? 'btn-on' : ''}`} aria-pressed={open} onClick={() => onToggle(h.id)}>
          Headers
        </button>
        {h.body && (
          <button className="btn-ghost btn-sm" onClick={() => navigator.clipboard.writeText(h.body)}>
            Copy body
          </button>
        )}
      </div>
    </div>
  );
});
