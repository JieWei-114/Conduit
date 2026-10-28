import { useEffect, useRef, useState } from 'react';
import { Empty, LongField, PanelHead } from './ui';
import { OutcomeView, type Outcome } from './AttemptLog';
import { downloadJson } from './share';

const LS = 'conduit.diag.v1';

function loadJson<T>(key: string, fb: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fb;
  } catch {
    return fb;
  }
}

/** A diag call's JSON answer; a failure to reach conduit itself, or an answer that is not JSON,
 *  comes back as `{ ok: false, error }` too, so every check shows why it has no result. */
async function post(path: string, body: unknown): Promise<any> {
  let r: Response;
  try {
    r = await fetch(`/api/diag/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `could not reach conduit's backend: ${(e as Error).message || e}` };
  }
  const text = await r.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `conduit's backend answered ${r.status} ${r.statusText}${text ? `: ${text.slice(0, 300)}` : ''}` };
  }
}

type Tool = 'tcp' | 'tls' | 'dns' | 'health';
const NAV: { id: Tool; label: string; desc: string }[] = [
  { id: 'tcp', label: 'TCP port', desc: 'Open a TCP connection to a host and port to prove the path is reachable.' },
  { id: 'tls', label: 'TLS certificate', desc: 'Read the certificate a host serves: subject, issuer, expiry and chain trust.' },
  { id: 'dns', label: 'DNS lookup', desc: 'Resolve a hostname to its A, AAAA, CNAME and MX records.' },
  { id: 'health', label: 'Health board', desc: 'Poll a list of HTTP endpoints and show each status code and response time.' },
];

/** A check's answer as the outcome every panel shows: `okText` when it passed, the failure
 *  (with its detail and log) when it did not. */
function outcomeOf(r: any, passed: boolean, okText: string): Outcome {
  if (r?.busy) return { ok: false, busy: true, text: 'Checking…' };
  if (passed) return { ok: true, text: okText, ms: r.ms, log: r.log ?? null };
  return { ok: false, text: r?.error || 'Unknown error', ms: r?.ms, detail: r?.detail ?? null, log: r?.log ?? null };
}

/** The health board's reading of one ping: a 3xx is a redirect, shown apart from healthy. */
function healthOf(r: any): 'healthy' | 'redirect' | 'unhealthy' | 'error' {
  if (!r?.ok) return 'error';
  const v = r.verdict ?? (r.status >= 300 && r.status < 400 ? 'redirect' : r.status < 300 ? 'healthy' : 'unhealthy');
  return v;
}

function certDate(iso: unknown, text: unknown): string {
  const raw = typeof iso === 'string' && iso ? iso : typeof text === 'string' ? text : '';
  if (!raw) return '-';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const days = Math.round((d.getTime() - Date.now()) / 86400000);
  const rel = days === 0 ? 'today' : days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC (${rel})`;
}

// Renewal automation usually runs at 30 days left; under 14 it will not happen on its own.
function ExpiryVerdict({ days }: { days: number }) {
  if (days <= 0)
    return (
      <>
        <div className="status bad">Failed · certificate expired {Math.abs(days)} days ago</div>
        <div className="hint mb-3">Every client verifying this chain is already refusing the connection. Reissue and redeploy the certificate, then re-run this check.</div>
      </>
    );
  if (days < 14)
    return (
      <>
        <div className="status bad">Failed · expires in {days} days</div>
        <div className="hint mb-3">
          Automatic renewal has not run and is unlikely to. Renew by hand now: clients start refusing the connection the moment it expires, with no
          warning of their own.
        </div>
      </>
    );
  if (days < 30)
    return (
      <>
        <div className="status warn">Warning · expires in {days} days</div>
        <div className="hint mb-3">Still valid, and nothing is broken yet. Renewal is usually scheduled at 30 days remaining, so check why the renewal job has not fired.</div>
      </>
    );
  return <div className="status ok">Passed · valid for another {days} days</div>;
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

  // why each check cannot run yet, or null when it can
  const portOk = (p: string) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };
  const tcpWhy = !f.tcpHost.trim()
    ? 'Enter a host first.'
    : !f.tcpPort.trim()
      ? 'Enter a port first.'
      : !portOk(f.tcpPort.trim())
        ? `"${f.tcpPort}" is not a port (1–65535).`
        : null;
  const tlsWhy = !f.tlsHost.trim()
    ? 'Enter a host first.'
    : f.tlsPort.trim() && !portOk(f.tlsPort.trim())
      ? `"${f.tlsPort}" is not a port (1–65535).`
      : null;
  const dnsWhy = !f.dnsHost.trim() ? 'Enter a hostname first.' : null;

  const runTcp = async () => {
    if (tcpWhy || tcp?.busy) return;
    setTcp({ busy: true });
    setTcp(await post('tcp', { host: f.tcpHost.trim(), port: Number(f.tcpPort.trim()) }));
  };
  const runTls = async () => {
    if (tlsWhy || tls?.busy) return;
    setTls({ busy: true });
    setTls(await post('tls', { host: f.tlsHost.trim(), port: f.tlsPort.trim() ? Number(f.tlsPort.trim()) : 443 }));
  };
  const runDns = async () => {
    if (dnsWhy || dns?.busy) return;
    setDns({ busy: true });
    setDns(await post('dns', { host: f.dnsHost.trim() }));
  };

  const urlList = () =>
    f.urls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//i.test(u));

  // read the latest URLs from a ref so the interval doesn't need f.urls in deps
  // (which would tear down + re-ping on every keystroke).
  const urlsRef = useRef(f.urls);
  urlsRef.current = f.urls;
  const [checking, setChecking] = useState(false);
  const healthRunning = useRef(false);
  const runHealth = async () => {
    if (healthRunning.current) return;
    healthRunning.current = true;
    const urls = urlsRef.current.split('\n').map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    setChecking(true);
    try {
      await Promise.all(
        urls.map(async (u) => {
          const r = await post('ping', { url: u });
          setHealth((h) => ({ ...h, [u]: r }));
        }),
      );
    } finally {
      healthRunning.current = false;
      setChecking(false);
    }
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

  /** The Check button and what it is waiting for: one row under every check's fields. */
  const checkRow = (busy: boolean, why: string | null, run: () => void, hint: string) => (
    <div className="inline mt-3">
      <button className="btn-primary" disabled={busy || !!why} onClick={run}>
        {busy ? 'Checking…' : 'Check'}
      </button>
      <span className="hint m-0">{why ?? hint}</span>
    </div>
  );

  const title = (id: Tool) => {
    const n = NAV.find((x) => x.id === id)!;
    return <PanelHead title={n.label} tagline={n.desc} />;
  };

  return (
    <div className="navlay">
      <div className="navlist">
        <div className="navlist-label">Network checks</div>
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
        {sel === 'tcp' && (
          <>
            {title('tcp')}
            <div className="row">
              <LongField className="grow" aria-label="Host" value={f.tcpHost} spellCheck={false} placeholder="host, e.g. example.com" onChange={(v) => set('tcpHost', v)} onEnter={runTcp} />
              <input className="w-xs" aria-label="Port" value={f.tcpPort} placeholder="443" onChange={(e) => set('tcpPort', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runTcp()} />
            </div>
            {checkRow(!!tcp?.busy, tcpWhy, runTcp, 'Enter in either field also checks.')}
            {tcp ? (
              <OutcomeView o={outcomeOf(tcp, tcp.open === true, 'Passed · port open')} secrets={[]} />
            ) : (
              <Empty
                icon="⇢"
                title="No result yet"
                hint={<>Enter a host and port, e.g. example.com and 443, then press <kbd>Check</kbd>. You get whether a TCP connection opened, and how long it took.</>}
              />
            )}
          </>
        )}

        {sel === 'tls' && (
          <>
            {title('tls')}
            <div className="row">
              <LongField className="grow" aria-label="Host" value={f.tlsHost} spellCheck={false} placeholder="host, e.g. example.com" onChange={(v) => set('tlsHost', v)} onEnter={runTls} />
              <input className="w-xs" aria-label="Port" value={f.tlsPort} placeholder="443" onChange={(e) => set('tlsPort', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runTls()} />
            </div>
            {checkRow(!!tls?.busy, tlsWhy, runTls, 'Enter in either field also checks.')}
            {tls ? (
              tls.ok ? (
                <div className="mt-3">
                  <OutcomeView
                    o={{
                      ...outcomeOf(tls, true, 'Certificate read'),
                      warn: !tls.authorized || (tls.daysLeft != null && tls.daysLeft < 30),
                    }}
                    secrets={[]}
                  />
                  {tls.authorized ? (
                    <div className="status ok">Passed · chain verifies against the Mozilla root list</div>
                  ) : (
                    <>
                      <div className="status bad">Failed · chain does not verify against the Mozilla root list: {tls.authError || 'unknown reason'}</div>
                      <div className="hint mb-3">
                        The certificate was served, but conduit checks it against the Mozilla root list it ships with (webpki-roots), not this
                        machine's own trust store. A self-signed or internal-CA certificate fails here even when this machine trusts that CA; a name
                        mismatch means the certificate is for a different hostname than the one requested.
                      </div>
                    </>
                  )}
                  {tls.daysLeft != null && <ExpiryVerdict days={tls.daysLeft} />}
                  <table className="rtable kv-table mt-3">
                    <tbody>
                      <tr>
                        <td>subject</td>
                        <td>
                          {tls.subject ||
                            ((tls.altNames || '').replace(/DNS:/g, '').split(',')[0]?.trim() ? (
                              <>
                                {(tls.altNames || '').replace(/DNS:/g, '').split(',')[0].trim()}{' '}
                                <span className="faint">(empty subject; first alt name)</span>
                              </>
                            ) : (
                              '-'
                            ))}
                        </td>
                      </tr>
                      <tr><td>issuer</td><td>{tls.issuer || '-'}</td></tr>
                      <tr><td>valid from</td><td title={tls.validFrom || undefined}>{certDate(tls.validFromIso ?? tls.notBefore, tls.validFrom)}</td></tr>
                      <tr><td>valid to</td><td title={tls.validTo || undefined}>{certDate(tls.validToIso ?? tls.notAfter, tls.validTo)}</td></tr>
                      <tr><td>days left</td><td>{tls.daysLeft ?? '-'}</td></tr>
                      <tr><td>alt names</td><td>{(tls.altNames || '').replace(/DNS:/g, '') || '-'}</td></tr>
                      <tr><td>protocol</td><td>{tls.protocol || '-'}{tls.chainLength != null ? ` · ${tls.chainLength} certificate${tls.chainLength === 1 ? '' : 's'} served` : ''}</td></tr>
                      <tr>
                        <td>timing</td>
                        <td>
                          {tls.tcpMs != null ? `TCP ${tls.tcpMs} ms · ` : ''}
                          {tls.handshakeMs != null ? `TLS handshake ${tls.handshakeMs} ms · ` : ''}total {tls.ms ?? '-'} ms
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <OutcomeView o={outcomeOf(tls, false, '')} secrets={[]} />
              )
            ) : (
              <Empty
                icon="⚿"
                title="No result yet"
                hint={<>Enter a host and TLS port, e.g. example.com and 443, then press <kbd>Check</kbd>. You get the issuer, the expiry date and whether the chain is trusted.</>}
              />
            )}
          </>
        )}

        {sel === 'dns' && (
          <>
            {title('dns')}
            <div className="row">
              <LongField className="grow" aria-label="Hostname" value={f.dnsHost} spellCheck={false} placeholder="hostname, e.g. example.com" onChange={(v) => set('dnsHost', v)} onEnter={runDns} />
            </div>
            {checkRow(!!dns?.busy, dnsWhy, runDns, 'Enter in the field also checks.')}
            {dns ? (
              <div className="mt-3">
                <OutcomeView o={outcomeOf(dns, dns.ok === true, 'Passed · name resolved')} secrets={[]} />
                {(dns.resolver || dns.os) && (
                  <table className="rtable kv-table mt-3">
                    <tbody>
                      {(['A', 'AAAA', 'CNAME', 'MX'] as const).map((t) => {
                        const vals: string[] =
                          t === 'MX' ? (dns.MX ?? []).map((m: any) => `${m.exchange} (${m.priority})`) : (dns[t] ?? []);
                        const err = dns.errors?.[t];
                        return (
                          <tr key={t}>
                            <td>{t}</td>
                            <td className="break">
                              {vals.join(', ') || (err ? <span className="faint">{err.code === 'NODATA' ? 'none' : `${err.code}: ${err.message}`}</span> : '-')}
                            </td>
                          </tr>
                        );
                      })}
                      {dns.os && (
                        <tr>
                          <td>this machine</td>
                          <td className="break">
                            {dns.os.ok ? (dns.os.addresses ?? []).join(', ') || '-' : <span className="faint">failed: {dns.os.error}</span>}
                          </td>
                        </tr>
                      )}
                      {dns.resolver && (
                        <tr><td>asked</td><td>{dns.resolver}; "this machine" is what other programs get (hosts file and VPN included)</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            ) : (
              <Empty
                icon="⌕"
                title="No result yet"
                hint={<>Enter a hostname such as example.com, then press <kbd>Check</kbd> to see its A, AAAA, CNAME and MX records.</>}
              />
            )}
          </>
        )}

        {sel === 'health' && (
          <>
            {title('health')}
            <label htmlFor="diag-urls">URLs</label>
            <textarea id="diag-urls" rows={4} value={f.urls} spellCheck={false} placeholder={'https://api.example.com/health\nhttps://other.internal/healthz'} onChange={(e) => set('urls', e.target.value)} />
            <div className="hint">One per line. Lines without an http:// or https:// scheme are ignored.</div>
            <div className="inline mt-3">
              <button className="btn-primary" disabled={checking || urlList().length === 0} onClick={runHealth}>
                {checking ? 'Checking…' : 'Check'}
              </button>
              <button className={`btn-secondary ${auto ? 'btn-on' : ''}`} aria-pressed={auto} onClick={() => setAuto(!auto)}>
                Poll every 10 s
              </button>
              {urlList().length === 0 && <span className="hint m-0">Add a URL first.</span>}
              <span className="spacer" />
              {urlList().some((u) => health[u]) && (
                <button
                  className="btn-ghost btn-sm"
                  title="Save the latest result for every URL as a JSON file"
                  onClick={() =>
                    downloadJson(
                      'diag',
                      'health',
                      urlList()
                        .filter((u) => health[u])
                        .map((u) => ({ url: u, health: healthOf(health[u]), ...health[u] })),
                    )
                  }
                >
                  Export JSON
                </button>
              )}
            </div>
            {urlList().length > 0 && Object.keys(health).length > 0 ? (
              <>
              <table className="rtable mt-3">
                <tbody>
                  {urlList().map((u) => {
                    const r = health[u];
                    const h = r ? healthOf(r) : null;
                    return (
                      <tr key={u}>
                        <td className="nowrap">
                          {!h ? (
                            <span className="badge">Not run</span>
                          ) : h === 'healthy' ? (
                            <span className="pill ok">Passed · {r.status}</span>
                          ) : h === 'redirect' ? (
                            <span className="pill warn" title={r.location ? `Location: ${r.location}` : 'no Location header'}>
                              Redirect · {r.status}
                            </span>
                          ) : h === 'error' ? (
                            <span className="pill bad">Failed</span>
                          ) : (
                            <span className="pill bad">Failed · {r.status}</span>
                          )}
                        </td>
                        <td className="nowrap">{r?.ms != null ? `${r.ms} ms` : ''}</td>
                        <td className="break">
                          {u}
                          {h === 'redirect' && <div className="faint">→ {r.location || '(no Location header)'}</div>}
                          {h === 'error' && (
                            <div className="text-bad one-line" title={r.error || undefined}>
                              {r.detail?.message || r.error || 'Unknown error'}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {urlList().map((u) => {
                const r = health[u];
                if (!r || healthOf(r) !== 'error') return null;
                return (
                  <details key={u} className="mt-2">
                    <summary className="break">Why {u} failed</summary>
                    <OutcomeView o={outcomeOf(r, false, '')} secrets={[]} />
                  </details>
                );
              })}
              {urlList().some((u) => health[u] && healthOf(health[u]) !== 'healthy') && (
                <div className="hint">
                  A 3xx means the endpoint answered with a redirect, not a health result: point the board at the Location it names. A 4xx or 5xx
                  means the service answered, so the problem is in the service rather than the network.
                </div>
              )}
              </>
            ) : (
              <Empty
                icon="◎"
                title={urlList().length > 0 ? 'No results yet' : 'No URLs yet'}
                hint={
                  urlList().length > 0 ? (
                    <>Press <kbd>Check</kbd> for one pass, or <kbd>Poll every 10 s</kbd> to keep watching. Each row shows a status code and a response time.</>
                  ) : (
                    <>Add one full URL per line above, e.g. https://example.com, then press <kbd>Check</kbd>.</>
                  )
                }
              />
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
