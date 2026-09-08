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
const NAV: { id: Tool; label: string; desc: string }[] = [
  { id: 'tcp', label: 'TCP port', desc: 'Open a TCP connection to a host and port to prove the path is reachable.' },
  { id: 'tls', label: 'TLS certificate', desc: 'Read the certificate a host serves: subject, issuer, expiry and chain trust.' },
  { id: 'dns', label: 'DNS lookup', desc: 'Resolve a hostname to its A, AAAA, CNAME and MX records.' },
  { id: 'health', label: 'Health board', desc: 'Poll a list of HTTP endpoints and show each status code and response time.' },
];

// Turns a failed probe into the next thing worth trying. A red box on its own
// tells the user only what they already know.
function tcpAdvice(host: string, port: string, error?: string): string {
  const e = error || '';
  if (e === 'timeout' || /ETIMEDOUT/i.test(e))
    return `No reply before the timeout, which usually means a firewall or security group is dropping the packets rather than refusing them. Check that ${host} is reachable from this network (VPN up?) and that port ${port} is allowed inbound.`;
  if (/ECONNREFUSED/i.test(e))
    return `The host answered, so the route is fine — nothing is listening on port ${port}. Check the service is running and bound to 0.0.0.0 rather than 127.0.0.1.`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(e))
    return `The hostname did not resolve, so no connection was attempted. Check the spelling, then use DNS lookup to see what ${host} resolves to.`;
  if (/EHOSTUNREACH|ENETUNREACH/i.test(e))
    return 'No route to the host. Check the subnet, route table and VPN before looking at the service itself.';
  return `Confirm the host and port, then check DNS lookup resolves ${host} before suspecting the service.`;
}

function tlsAdvice(error?: string): string {
  const e = error || '';
  if (/ECONNREFUSED/i.test(e))
    return 'Nothing is listening on that port. Confirm the port carries TLS — plain HTTP is usually 80, TLS 443.';
  if (/timeout|ETIMEDOUT/i.test(e))
    return 'The handshake never completed. Use TCP port on the same host and port first to separate a network problem from a TLS one.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(e))
    return 'The hostname did not resolve. Check the spelling, then use DNS lookup.';
  if (/wrong version|protocol|SSL routines/i.test(e))
    return 'The port answered but did not speak TLS. It is most likely a plaintext port.';
  return 'Check the host and port, then use TCP port to confirm the port is open at all.';
}

function dnsAdvice(error?: string): string {
  const e = error || '';
  if (/ENOTFOUND|NXDOMAIN/i.test(e))
    return 'No such name in DNS. Check the spelling, and whether the name is internal-only and needs a VPN or a private resolver.';
  if (/ENODATA/i.test(e))
    return 'The name exists but has no records of this type. It may only carry a CNAME, or only records this lookup does not request.';
  if (/EAI_AGAIN|ESERVFAIL|SERVFAIL/i.test(e))
    return 'The resolver itself failed to answer. Retry, then check the machine has a working DNS server configured.';
  return 'Enter a bare hostname without a scheme or path, for example api.example.com.';
}

// Thresholds follow how renewal actually fails: automation is normally set to
// renew with 30 days left, so 30–14 days remaining means a renewal that should
// already have happened has not, and under 14 days means it will not happen on
// its own. Only an expired certificate is currently breaking traffic.
function ExpiryVerdict({ days }: { days: number }) {
  if (days <= 0)
    return (
      <>
        <div className="status bad">FAIL — certificate expired {Math.abs(days)} days ago</div>
        <div className="hint mb-3">Every client verifying this chain is already refusing the connection. Reissue and redeploy the certificate, then re-run this check.</div>
      </>
    );
  if (days < 14)
    return (
      <>
        <div className="status bad">FAIL — expires in {days} days</div>
        <div className="hint mb-3">
          Automatic renewal has not run and is unlikely to. Renew by hand now: clients start refusing the connection the moment it expires, with no
          warning of their own.
        </div>
      </>
    );
  if (days < 30)
    return (
      <>
        <div className="status warn">WARN — expires in {days} days</div>
        <div className="hint mb-3">Still valid, and nothing is broken yet. Renewal is usually scheduled at 30 days remaining, so check why the renewal job has not fired.</div>
      </>
    );
  return <div className="status ok">PASS — valid for another {days} days</div>;
}

function Empty({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="empty mt-3">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
    </div>
  );
}

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

  const title = (id: Tool) => {
    const n = NAV.find((x) => x.id === id)!;
    return (
      <div className="util-title">
        {n.label}
        <div className="hint">{n.desc}</div>
      </div>
    );
  };

  return (
    <div className="navlay">
      <div className="navlist">
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
        {sel === 'tcp' && (
          <>
            {title('tcp')}
            <div className="row field-row">
              <input className="grow" value={f.tcpHost} spellCheck={false} placeholder="host (e.g. db.internal)" onChange={(e) => set('tcpHost', e.target.value)} />
              <input className="w-xs" value={f.tcpPort} placeholder="port" onChange={(e) => set('tcpPort', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runTcp()} />
              <button className="btn-field" disabled={!f.tcpHost.trim() || !f.tcpPort.trim()} onClick={runTcp}>check</button>
            </div>
            {tcp ? (
              <div className="mt-3">
                {tcp.open ? (
                  <div className="status ok">PASS — port open · {tcp.ms}ms</div>
                ) : (
                  <>
                    <div className="status bad">
                      FAIL — {tcp.error === 'timeout' ? 'timed out' : /ECONNREFUSED/i.test(tcp.error || '') ? 'connection refused' : tcp.error || 'closed'}
                      {tcp.ms != null ? ` · ${tcp.ms}ms` : ''}
                    </div>
                    <div className="hint">{tcpAdvice(f.tcpHost.trim(), f.tcpPort.trim(), tcp.error)}</div>
                  </>
                )}
              </div>
            ) : (
              <Empty
                icon="⇢"
                title="Not run yet"
                hint="Enter a host and port, then press check. The result says whether a TCP connection completed, and how long it took."
              />
            )}
          </>
        )}

        {sel === 'tls' && (
          <>
            {title('tls')}
            <div className="row field-row">
              <input className="grow" value={f.tlsHost} spellCheck={false} placeholder="host (e.g. api.example.com)" onChange={(e) => set('tlsHost', e.target.value)} />
              <input className="w-xs" value={f.tlsPort} placeholder="443" onChange={(e) => set('tlsPort', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runTls()} />
              <button className="btn-field" onClick={runTls}>check</button>
            </div>
            {tls ? (
              tls.ok ? (
                <div className="mt-3">
                  {tls.authorized ? (
                    <div className="status ok">PASS — chain trusted by this machine</div>
                  ) : (
                    <>
                      <div className="status bad">FAIL — chain not trusted · {tls.authError || 'unknown reason'}</div>
                      <div className="hint mb-3">
                        The certificate was served but could not be verified. A self-signed or internal-CA certificate needs that CA installed on this
                        machine; a name mismatch means the certificate is for a different hostname than the one requested.
                      </div>
                    </>
                  )}
                  {tls.daysLeft != null && <ExpiryVerdict days={tls.daysLeft} />}
                  <table className="rtable">
                    <tbody>
                      <tr><td>subject</td><td>{tls.subject || '-'}</td></tr>
                      <tr><td>issuer</td><td>{tls.issuer || '-'}</td></tr>
                      <tr><td>valid to</td><td>{tls.validTo || '-'}</td></tr>
                      <tr><td>days left</td><td>{tls.daysLeft ?? '-'}</td></tr>
                      <tr><td>alt names</td><td>{(tls.altNames || '').replace(/DNS:/g, '') || '-'}</td></tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-3">
                  <div className="status bad">FAIL — no certificate read · {tls.error || 'unknown error'}</div>
                  <div className="hint">{tlsAdvice(tls.error)}</div>
                </div>
              )
            ) : (
              <Empty
                icon="⚿"
                title="Not run yet"
                hint="Enter a host and a TLS port, then press check. The result shows who issued the certificate, when it expires and whether the chain is trusted."
              />
            )}
          </>
        )}

        {sel === 'dns' && (
          <>
            {title('dns')}
            <div className="row field-row">
              <input className="grow" value={f.dnsHost} spellCheck={false} placeholder="hostname" onChange={(e) => set('dnsHost', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runDns()} />
              <button className="btn-field" onClick={runDns}>resolve</button>
            </div>
            {dns ? (
              dns.ok ? (
                <div className="mt-3">
                  <div className="status ok">PASS — name resolved</div>
                  <table className="rtable">
                    <tbody>
                      <tr><td>A</td><td>{(dns.A ?? []).join(', ') || '-'}</td></tr>
                      <tr><td>AAAA</td><td>{(dns.AAAA ?? []).join(', ') || '-'}</td></tr>
                      <tr><td>CNAME</td><td>{(dns.CNAME ?? []).join(', ') || '-'}</td></tr>
                      <tr><td>MX</td><td>{(dns.MX ?? []).map((m: any) => `${m.exchange} (${m.priority})`).join(', ') || '-'}</td></tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-3">
                  <div className="status bad">FAIL — {dns.error || 'not resolved'}</div>
                  <div className="hint">{dnsAdvice(dns.error)}</div>
                </div>
              )
            ) : (
              <Empty
                icon="⌕"
                title="Not run yet"
                hint="Enter a hostname such as api.example.com, then press resolve to see its A, AAAA, CNAME and MX records."
              />
            )}
          </>
        )}

        {sel === 'health' && (
          <>
            {title('health')}
            <label>URLs</label>
            <textarea rows={4} value={f.urls} spellCheck={false} placeholder={'https://api.example.com/health\nhttps://other.internal/healthz'} onChange={(e) => set('urls', e.target.value)} />
            <div className="hint">One per line. Lines without an http:// or https:// scheme are ignored.</div>
            <div className="inline mt-3">
              <button className="mini" onClick={runHealth}>check now</button>
              <button className={`btn-field ${auto ? 'btn-on' : ''}`} aria-pressed={auto} onClick={() => setAuto(!auto)}>
                auto 10s
              </button>
            </div>
            {urlList().length > 0 && Object.keys(health).length > 0 ? (
              <>
              <table className="rtable mt-3">
                <tbody>
                  {urlList().map((u) => {
                    const r = health[u];
                    const passed = r && r.ok && (r.status == null || r.status < 400);
                    return (
                      <tr key={u}>
                        <td className="nowrap">
                          {!r ? (
                            <span className="badge">not run</span>
                          ) : (
                            <span className={passed ? 'ok' : 'bad'}>{passed ? `PASS ${r.status ?? ''}` : `FAIL ${r.status ?? r.error ?? ''}`}</span>
                          )}
                        </td>
                        <td className="nowrap">{r?.ms != null ? `${r.ms}ms` : ''}</td>
                        <td className="break">{u}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {urlList().some((u) => health[u] && !(health[u].ok && (health[u].status == null || health[u].status < 400))) && (
                <div className="hint">
                  For a failing row, check the URL in TCP port to see whether the port is reachable at all, then in TLS certificate if it is an https
                  endpoint. A 4xx or 5xx means the service answered, so the problem is in the service rather than the network.
                </div>
              )}
              </>
            ) : (
              <Empty
                icon="◎"
                title={urlList().length > 0 ? 'Not run yet' : 'No URLs to poll'}
                hint={
                  urlList().length > 0
                    ? 'Press check now for a single pass, or auto 10s to keep polling. Each row will show a status code and a response time.'
                    : 'Add one full URL per line above, then press check now to see which endpoints answer.'
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
