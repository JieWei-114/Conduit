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

        <label>Your capture URL — point any caller here</label>
        <div className="row field-row">
          <input className="grow" readOnly value={captureUrl} spellCheck={false} onFocus={(e) => e.target.select()} />
          <button className="btn-field" onClick={() => navigator.clipboard.writeText(captureUrl)}>copy</button>
        </div>
        <div className="hint">
          Any method, any sub-path (e.g. <code>{captureUrl}payment/callback</code>) is captured. Use your LAN IP
          instead of localhost if the caller is another machine.
        </div>

        <div className="row field-row" style={{ marginTop: 12 }}>
          <button className={`btn-field ${live ? 'btn-danger' : ''}`} onClick={connect}>
            {live ? 'stop listening' : 'start listening'}
          </button>
          <div className="hint" style={{ margin: 0 }}>
            {live ? '🟢 live — new hits stream in' : '⚪ not listening (past hits still load)'}
          </div>
        </div>

        <label style={{ marginTop: 16 }}>Response returned to the caller</label>
        <div className="row field-row">
          <div style={{ flex: '0 0 90px' }}>
            <input value={resp.status} placeholder="200" onChange={(e) => setResp((r) => ({ ...r, status: e.target.value }))} />
          </div>
          <input className="grow" value={resp.contentType} spellCheck={false} placeholder="application/json" onChange={(e) => setResp((r) => ({ ...r, contentType: e.target.value }))} />
        </div>
        <textarea rows={3} style={{ marginTop: 8 }} value={resp.body} spellCheck={false} placeholder='{"ok":true}' onChange={(e) => setResp((r) => ({ ...r, body: e.target.value }))} />
        <div className="row field-row" style={{ marginTop: 10 }}>
          <button style={{ width: 'auto', marginTop: 0 }} onClick={saveResp}>save response</button>
          {savedMsg && <span className="hint" style={{ margin: 0 }}>{savedMsg}</span>}
        </div>
      </div>

      <div className="right">
        {hits.length > 0 && (
          <div className="feed-head">
            <span className="count">{fq ? `${shown.length} / ${hits.length}` : hits.length} hits</span>
            <input
              className="grow"
              style={{ margin: '0 8px', padding: '2px 6px', fontSize: 12 }}
              placeholder="filter path / method / body / headers"
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
            <span className="chip" onClick={clearAll}>clear</span>
          </div>
        )}
        {hits.length === 0 && (
          <pre>No requests captured yet. Click “start listening”, then send a request to your capture URL.</pre>
        )}
        <div className="feed">
          {shown.map((h) => {
            const open = expanded === h.id;
            const pretty = tryJson(h.body);
            return (
              <div key={h.id} className="feed-item">
                <span className="feed-ch">
                  <b>{h.method}</b> {h.path}
                  <span className="chip" style={{ marginLeft: 8 }} onClick={() => setExpanded(open ? null : h.id)}>
                    {open ? 'hide' : 'headers'}
                  </span>
                  {h.body && (
                    <span className="chip" style={{ marginLeft: 6 }} onClick={() => navigator.clipboard.writeText(h.body)}>
                      copy body
                    </span>
                  )}
                </span>
                <span className="feed-time">{new Date(h.at).toLocaleTimeString()}</span>
                {Object.keys(h.query).length > 0 && <div className="feed-props">query {JSON.stringify(h.query)}</div>}
                {open && (
                  <div className="feed-props" style={{ whiteSpace: 'pre-wrap' }}>
                    {Object.entries(h.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                  </div>
                )}
                {h.body && <div className="feed-msg">{pretty ?? h.body}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
