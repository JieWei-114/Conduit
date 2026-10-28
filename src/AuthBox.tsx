import { useMemo, useState, type ReactNode } from 'react';
import { LongField, Section } from './ui';

/**
 * Reusable auth block: Bearer (JWT) / Basic / Raw header / OAuth2
 * client-credentials / None. Owns no storage — the host panel keeps AuthState
 * (per tab / per form) and renders <AuthBox value onChange/>.
 * `authHeader()` turns the state into the Authorization header value.
 */
export interface AuthState {
  type: 'bearer' | 'basic' | 'raw' | 'oauth2' | 'none';
  bearer: string; // JWT / opaque token (also receives the OAuth2 fetched token)
  basicUser: string;
  basicPass: string;
  raw: string; // full Authorization value, any scheme
  oauthIssuer: string; // token endpoint URL
  oauthClientId: string;
  oauthClientSecret: string;
  oauthAudience: string;
}

export const AUTH_DEFAULTS: AuthState = {
  type: 'bearer',
  bearer: '',
  basicUser: '',
  basicPass: '',
  raw: '',
  oauthIssuer: '',
  oauthClientId: '',
  oauthClientSecret: '',
  oauthAudience: '',
};

/** base64 that survives non-latin1 (unicode) passwords — btoa alone throws. */
function b64utf8(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export function authHeader(a: AuthState | undefined): string {
  if (!a) return '';
  switch (a.type) {
    case 'bearer':
    case 'oauth2':
      return a.bearer.trim() ? `Bearer ${a.bearer.trim()}` : '';
    case 'basic':
      return a.basicUser || a.basicPass ? `Basic ${b64utf8(`${a.basicUser}:${a.basicPass}`)}` : '';
    case 'raw':
      return a.raw.trim();
    default:
      return '';
  }
}

/** Decode a JWT header + payload without verifying — for display only. */
export function decodeJwt(
  token: string,
): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parts = token.trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) return null;
  const dec = (s: string) => {
    // base64url → base64, then pad to a multiple of 4 (atob rejects unpadded input)
    let b = s.replace(/-/g, '+').replace(/_/g, '/');
    b += '='.repeat((4 - (b.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(b)))); // unicode-safe
  };
  try {
    return { header: dec(parts[0]), payload: dec(parts[1]) };
  } catch {
    return null;
  }
}

const TIME_CLAIMS = new Set(['exp', 'iat', 'nbf']);
function claimValue(k: string, v: unknown): string {
  if (TIME_CLAIMS.has(k) && typeof v === 'number')
    return `${v} (${new Date(v * 1000).toLocaleString()})`;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export default function AuthBox({
  value,
  onChange,
  note,
}: {
  value: AuthState;
  onChange: (next: AuthState) => void;
  note?: ReactNode;
}) {
  const a = { ...AUTH_DEFAULTS, ...value };
  const set = <K extends keyof AuthState>(k: K, v: AuthState[K]) => onChange({ ...a, [k]: v });
  const [oauthStatus, setOauthStatus] = useState('');

  // decode whatever token-ish thing is active (bearer, oauth-fetched, or raw)
  const tokenText = a.type === 'raw' ? a.raw : a.type === 'basic' || a.type === 'none' ? '' : a.bearer;
  const jwt = useMemo(() => decodeJwt(tokenText), [tokenText]);
  const jwtExp = jwt && typeof jwt.payload.exp === 'number' ? jwt.payload.exp * 1000 : null;
  const jwtExpired = jwtExp != null && jwtExp < Date.now();

  // OAuth2 client-credentials: swap id/secret for a token via the local proxy
  // (no CORS), then stash it in `bearer` so authHeader() picks it up.
  const fetchToken = async () => {
    setOauthStatus('fetching token…');
    try {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: a.oauthClientId,
        client_secret: a.oauthClientSecret,
        ...(a.oauthAudience.trim() ? { audience: a.oauthAudience.trim() } : {}),
      }).toString();
      const r = await fetch('/api/http/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: a.oauthIssuer.trim(),
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          timeoutMs: 10000,
        }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error);
      const parsed = JSON.parse(r.bodyText ?? '{}');
      if (!parsed.access_token)
        throw new Error(`no access_token in response (HTTP ${r.status}): ${String(r.bodyText).slice(0, 200)}`);
      onChange({ ...a, bearer: parsed.access_token });
      setOauthStatus(
        `token fetched ✓${parsed.expires_in ? ` · expires in ${Math.round(parsed.expires_in / 60)}min` : ''}`,
      );
    } catch (e: any) {
      setOauthStatus(`✗ ${String(e?.message ?? e)}`);
    }
  };

  return (
    <Section
      title="Auth"
      actions={
        <select
          className="w-lg"
          aria-label="Auth type"
          value={a.type}
          onChange={(e) => set('type', e.target.value as AuthState['type'])}
        >
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic (user + password)</option>
          <option value="raw">Raw Authorization value</option>
          <option value="oauth2">OAuth2 client credentials</option>
          <option value="none">None</option>
        </select>
      }
    >
      {(a.type === 'bearer' || a.type === 'oauth2') && (
        <>
          {a.type === 'oauth2' && (
            <>
              <label className="field-first">Token endpoint</label>
              <LongField url value={a.oauthIssuer} spellCheck={false} placeholder="https://auth.example.com/oauth/token"
                onChange={(v) => set('oauthIssuer', v)} />
              <div className="hint">The issuer URL that exchanges client credentials for a token.</div>
              <div className="row mt-2">
                <LongField placeholder="client_id" value={a.oauthClientId} spellCheck={false}
                  onChange={(v) => set('oauthClientId', v)} />
                <input type="password" placeholder="client_secret" value={a.oauthClientSecret}
                  onChange={(e) => set('oauthClientSecret', e.target.value)} />
              </div>
              <div className="row mt-2">
                <LongField className="grow" placeholder="audience (optional)" value={a.oauthAudience} spellCheck={false}
                  onChange={(v) => set('oauthAudience', v)} />
                <button className="btn-secondary" title="Exchange the client credentials for an access token"
                  disabled={!a.oauthIssuer.trim()} onClick={fetchToken}>
                  Get token
                </button>
              </div>
              {oauthStatus && <div className="hint">{oauthStatus}</div>}
            </>
          )}
          {a.type === 'oauth2' && <label>Token</label>}
          <textarea rows={3} aria-label="Token" value={a.bearer} placeholder="eyJhbGciOi..." spellCheck={false}
            onChange={(e) => set('bearer', e.target.value)} />
          <div className="hint">
            {a.type === 'oauth2'
              ? 'Filled in by Get token, or paste one here.'
              : 'Sent as Authorization: Bearer <token>. Paste the token only; a JWT is decoded below.'}
          </div>
        </>
      )}

      {a.type === 'basic' && (
        <>
          <div className="row">
            <input placeholder="username" value={a.basicUser} spellCheck={false}
              onChange={(e) => set('basicUser', e.target.value)} />
            <input type="password" placeholder="password" value={a.basicPass}
              onChange={(e) => set('basicPass', e.target.value)} />
          </div>
          {(a.basicUser || a.basicPass) && (
            <div className="hint break">Sends Authorization: Basic {b64utf8(`${a.basicUser}:${a.basicPass}`)}</div>
          )}
        </>
      )}

      {a.type === 'raw' && (
        <>
          <LongField aria-label="Authorization value" value={a.raw} spellCheck={false} placeholder="Token abc123  ·  Bearer xyz  ·  custom-scheme …"
            onChange={(v) => set('raw', v)} />
          <div className="hint">Sent as the whole Authorization header value, any scheme.</div>
        </>
      )}

      {jwt && (
        <div className={`jwt ${jwtExpired ? 'jwt-bad' : ''}`}>
          <table className="jwt-table">
            <tbody>
              <tr>
                <td className="jwt-k">JWT</td>
                <td className={jwtExpired ? 'jwt-exp' : 'jwt-ok'}>
                  {jwtExpired ? 'expired' : 'not expired'}
                </td>
              </tr>
              <tr>
                <td className="jwt-k">alg</td>
                <td>{String(jwt.header.alg ?? '-')}</td>
              </tr>
              {jwt.header.kid != null && (
                <tr>
                  <td className="jwt-k">kid</td>
                  <td>{String(jwt.header.kid)}</td>
                </tr>
              )}
              <tr className="jwt-divider">
                <td colSpan={2} />
              </tr>
              {Object.entries(jwt.payload).map(([k, v]) => (
                <tr key={k}>
                  <td className="jwt-k">{k}</td>
                  <td>{claimValue(k, v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <div className="hint">{note}</div>}
    </Section>
  );
}
