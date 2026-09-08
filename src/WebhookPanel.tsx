import { useEffect, useRef, useState } from 'react';

interface Hit {
  id: number;
  at: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

function tryJson(s: string): string | null {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

export default function WebhookPanel() {
  const [hits, setHits] = useState<Hit[]>([]);
  const [filter, setFilter] = useState('');
  const [live, setLive] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [resp, setResp] = useState({ status: '200', contentType: 'application/json', body: '{"ok":true}' });
  const [savedMsg, setSavedMsg] = useState('');
  const esRef = useRef<EventSource | null>(null);

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
    setSavedMsg(r.ok ? 'saved ✓' : '✗');
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

  return (
    <div className="layout">
      <div className="left">
        <h3>
          Webhook <span className="badge">inbound capture</span>
        </h3>

        <label>Capture URL</label>
        <div className="row field-row">
          <input className="grow" readOnly value={captureUrl} spellCheck={false} onFocus={(e) => e.target.select()} />
          <button className="btn-field" title="Copy the capture URL to the clipboard" onClick={() => navigator.clipboard.writeText(captureUrl)}>Copy</button>
        </div>
        <div className="hint">
          Point any caller here. Any method, any sub-path (e.g. <code>{captureUrl}payment/callback</code>) is
          captured. Use your LAN IP instead of localhost if the caller is another machine.
        </div>

        <div className="row field-row field-row-gap">
          <button className={`btn-field ${live ? 'btn-on' : ''}`} onClick={connect}>
            {live ? 'Stop listening' : 'Start listening'}
          </button>
          <div className="hint">Past hits load either way; listening streams new ones as they arrive.</div>
        </div>
        <div className={`${live ? 'status ok' : 'status'} mt-2`}>{live ? 'Listening' : 'Not listening'}</div>

        <label>Canned response</label>
        <div className="row field-row">
          <div className="w-xs">
            <input value={resp.status} placeholder="200" title="HTTP status code returned to the caller" onChange={(e) => setResp((r) => ({ ...r, status: e.target.value }))} />
          </div>
          <input className="grow" value={resp.contentType} spellCheck={false} placeholder="application/json" title="Content-Type returned to the caller" onChange={(e) => setResp((r) => ({ ...r, contentType: e.target.value }))} />
        </div>
        <textarea className="mt-2" rows={3} value={resp.body} spellCheck={false} placeholder='{"ok":true}' onChange={(e) => setResp((r) => ({ ...r, body: e.target.value }))} />
        <div className="hint">Every captured request gets this status, content type and body back.</div>
        <button onClick={saveResp}>Save response</button>
        {savedMsg && <div className="toast">{savedMsg}</div>}
      </div>

      <div className="right">
        {hits.length > 0 && (
          <div className="feed-head inline">
            <span className="count">{fq ? `${shown.length} / ${hits.length}` : hits.length} hits</span>
            <input
              className="grow"
              placeholder="filter path / method / body / headers"
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button className="btn-field btn-danger" title="Discard every captured request" onClick={clearAll}>Clear</button>
          </div>
        )}
        {hits.length === 0 && !live && (
          <div className="empty">
            <div className="empty-icon">◈</div>
            <div className="empty-title">Not listening</div>
            <div className="empty-hint">Press <kbd>Start listening</kbd> on the left, then send a request to your capture URL.</div>
          </div>
        )}
        {hits.length === 0 && live && (
          <div className="empty">
            <div className="empty-icon">◈</div>
            <div className="empty-title">Listening, no hits yet</div>
            <div className="empty-hint">Send a request to your capture URL and it will appear here with its headers and body.</div>
          </div>
        )}
        <div className="feed">
          {shown.map((h) => {
            const open = expanded === h.id;
            const pretty = tryJson(h.body);
            return (
              <div key={h.id} className="feed-item">
                <span className="feed-ch">
                  <b>{h.method}</b> {h.path}
                </span>
                <span className="feed-time">{new Date(h.at).toLocaleTimeString()}</span>
                {Object.keys(h.query).length > 0 && <div className="feed-props break">query {JSON.stringify(h.query)}</div>}
                {open && (
                  <div className="feed-msg faint">
                    {Object.entries(h.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </div>
                )}
                {h.body && <div className="feed-msg break">{pretty ?? h.body}</div>}
                <div className="inline mt-1">
                  <button
                    className={`btn-ghost ${open ? 'btn-on' : ''}`}
                    title={open ? 'Hide the request headers' : 'Show the request headers'}
                    onClick={() => setExpanded(open ? null : h.id)}
                  >
                    {open ? 'Hide headers' : 'Headers'}
                  </button>
                  {h.body && (
                    <button className="btn-field" title="Copy this request body to the clipboard" onClick={() => navigator.clipboard.writeText(h.body)}>
                      Copy body
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
