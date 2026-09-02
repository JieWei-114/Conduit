import { useEffect, useRef, useState } from 'react';

const LS = 'conduit.diag.v1';

function loadJson<T>(key: string, fb: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fb;
  } catch {
    return fb;
  }
}

const post = (path: string, body: unknown) =>
  fetch(`/api/diag/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

type Tool = 'tcp' | 'tls' | 'dns' | 'health';
const NAV: { id: Tool; label: string }[] = [
  { id: 'tcp', label: 'TCP port' },
  { id: 'tls', label: 'TLS certificate' },
  { id: 'dns', label: 'DNS lookup' },
  { id: 'health', label: 'Health board' },
];

interface Persisted {
  tcpHost: string;
  tcpPort: string;
  tlsHost: string;
  tlsPort: string;
  dnsHost: string;
  urls: string;
}
const DEF: Persisted = { tcpHost: '', tcpPort: '', tlsHost: '', tlsPort: '443', dnsHost: '', urls: '' };

export default function DiagPanel() {
  const [sel, setSel] = useState<Tool>('tcp');
  const [f, setF] = useState<Persisted>(() => ({ ...DEF, ...loadJson(LS, {}) }));
  const set = <K extends keyof Persisted>(k: K, v: Persisted[K]) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => localStorage.setItem(LS, JSON.stringify(f)), [f]);

  const [tcp, setTcp] = useState<any>(null);
  const [tls, setTls] = useState<any>(null);
  const [dns, setDns] = useState<any>(null);
  const [health, setHealth] = useState<Record<string, any>>({});
  const [auto, setAuto] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const runTcp = async () => {
    if (!f.tcpHost.trim() || !f.tcpPort.trim()) return;
    setTcp(await post('tcp', { host: f.tcpHost.trim(), port: Number(f.tcpPort) }));
  };
  const runTls = async () => setTls(await post('tls', { host: f.tlsHost.trim(), port: Number(f.tlsPort) || 443 }));
  const runDns = async () => setDns(await post('dns', { host: f.dnsHost.trim() }));

  const urlList = () =>
    f.urls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));

  // read the latest URLs from a ref so the interval doesn't need f.urls in deps
  // (which would tear down + re-ping on every keystroke).
  const urlsRef = useRef(f.urls);
  urlsRef.current = f.urls;
  const runHealth = async () => {
    const urls = urlsRef.current.split('\n').map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    await Promise.all(
      urls.map(async (u) => {
        const r = await post('ping', { url: u }).catch((e) => ({ ok: false, error: String(e) }));
        setHealth((h) => ({ ...h, [u]: r }));
      }),
    );
  };

  useEffect(() => {
    if (auto) {
      runHealth();
      timer.current = setInterval(runHealth, 10000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const statusColor = (s?: number) =>
    s == null ? 'var(--text-faint)' : s < 300 ? 'var(--ok)' : s < 400 ? 'var(--warn)' : 'var(--bad)';

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
        {sel === 'tcp' && (
          <>
            <div className="util-title">TCP port check</div>
            <div className="row field-row">
              <input className="grow" value={f.tcpHost} spellCheck={false} placeholder="host (e.g. db.internal)" onChange={(e) => set('tcpHost', e.target.value)} />
              <input style={{ maxWidth: 100 }} value={f.tcpPort} placeholder="port" onChange={(e) => set('tcpPort', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runTcp()} />
              <button className="btn-field" onClick={runTcp}>check</button>
            </div>
            {tcp && (
              <div className={`hint ${tcp.open ? '' : 'error'}`} style={{ marginTop: 8 }}>
                {tcp.open
                  ? `🟢 open · ${tcp.ms}ms`
                  : tcp.error === 'timeout'
                    ? '🔴 filtered / no route (timeout)'
                    : /ECONNREFUSED/i.test(tcp.error || '')
                      ? `🔴 closed — connection refused · ${tcp.ms}ms`
                      : `🔴 ${tcp.error || 'closed'}`}
              </div>
            )}
          </>
        )}

        {sel === 'tls' && (
          <>
            <div className="util-title">TLS certificate</div>
            <div className="row field-row">
              <input className="grow" value={f.tlsHost} spellCheck={false} placeholder="host (e.g. api.example.com)" onChange={(e) => set('tlsHost', e.target.value)} />
              <input style={{ maxWidth: 100 }} value={f.tlsPort} placeholder="443" onChange={(e) => set('tlsPort', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runTls()} />
              <button className="btn-field" onClick={runTls}>check</button>
            </div>
            {tls &&
              (tls.ok ? (
                <table className="rtable" style={{ marginTop: 10 }}>
                  <tbody>
                    <tr><td>subject</td><td>{tls.subject || '-'}</td></tr>
                    <tr><td>issuer</td><td>{tls.issuer || '-'}</td></tr>
                    <tr><td>valid to</td><td>{tls.validTo || '-'}</td></tr>
                    <tr>
                      <td>days left</td>
                      <td style={{ color: tls.daysLeft != null && tls.daysLeft < 14 ? 'var(--bad)' : tls.daysLeft != null && tls.daysLeft < 30 ? 'var(--warn)' : undefined, fontWeight: 600 }}>
                        {tls.daysLeft ?? '-'}
                      </td>
                    </tr>
                    <tr><td>alt names</td><td>{(tls.altNames || '').replace(/DNS:/g, '') || '-'}</td></tr>
                    <tr>
                      <td>trust</td>
                      <td style={{ color: tls.authorized ? 'var(--ok)' : 'var(--warn)' }}>
                        {tls.authorized ? 'valid chain' : `untrusted — ${tls.authError || 'unknown'}`}
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <div className="hint error" style={{ marginTop: 8 }}>🔴 {tls.error}</div>
              ))}
          </>
        )}

        {sel === 'dns' && (
          <>
            <div className="util-title">DNS lookup</div>
            <div className="row field-row">
              <input className="grow" value={f.dnsHost} spellCheck={false} placeholder="hostname" onChange={(e) => set('dnsHost', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runDns()} />
              <button className="btn-field" onClick={runDns}>resolve</button>
            </div>
            {dns && dns.ok && (
              <table className="rtable" style={{ marginTop: 10 }}>
                <tbody>
                  <tr><td>A</td><td>{(dns.A ?? []).join(', ') || '-'}</td></tr>
                  <tr><td>AAAA</td><td>{(dns.AAAA ?? []).join(', ') || '-'}</td></tr>
                  <tr><td>CNAME</td><td>{(dns.CNAME ?? []).join(', ') || '-'}</td></tr>
                  <tr><td>MX</td><td>{(dns.MX ?? []).map((m: any) => `${m.exchange} (${m.priority})`).join(', ') || '-'}</td></tr>
                </tbody>
              </table>
            )}
            {dns && !dns.ok && <div className="hint error" style={{ marginTop: 8 }}>🔴 {dns.error}</div>}
          </>
        )}

        {sel === 'health' && (
          <>
            <div className="util-title">Health board</div>
            <label style={{ marginTop: 0 }}>URLs (one per line)</label>
            <textarea rows={4} value={f.urls} spellCheck={false} placeholder={'https://api.example.com/health\nhttps://other.internal/healthz'} onChange={(e) => set('urls', e.target.value)} />
            <div className="row field-row">
              <button style={{ width: 'auto' }} onClick={runHealth}>check now</button>
              <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                auto every 10s
              </label>
            </div>
            {urlList().length > 0 && Object.keys(health).length > 0 && (
              <table className="rtable" style={{ marginTop: 10 }}>
                <tbody>
                  {urlList().map((u) => {
                    const r = health[u];
                    return (
                      <tr key={u}>
                        <td style={{ color: statusColor(r?.status) }}>
                          {r ? (r.ok ? `● ${r.status}` : `✗ ${r.error}`) : '…'}
                        </td>
                        <td>{r?.ms != null ? `${r.ms}ms` : ''}</td>
                        <td>{u}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
