import { maskSecrets } from './vars';

export const MASK = '•••';

/** One shell word for bash or zsh; control characters use `$'…'` so a newline cannot end a `\`-continued command. */
export function shellQuote(s: string): string {
  if (!/[\x00-\x1f\x7f]/.test(s)) return `'${s.replace(/'/g, `'\\''`)}'`;
  const escaped = s.replace(/[\\'\x00-\x1f\x7f]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\\\';
      case "'":
        return "\\'";
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
    }
  });
  return `$'${escaped}'`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fileStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** Revoking the object URL at once can cancel the download in an embedded webview. */
export function downloadText(panel: string, what: string, ext: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = `conduit-${panel}-${what}-${fileStamp()}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function downloadJson(panel: string, what: string, data: unknown) {
  downloadText(panel, what, 'json', JSON.stringify(data, null, 2), 'application/json');
}

const SENSITIVE =
  /auth|token|key|secret|cookie|session|signature|passw|pwd|credential|(^|[^a-z])sig($|[^a-z])/i;

/** Whether a header, query or field name holds a credential by its name alone. */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE.test(name);
}

/** A raw query string with the values of credential-looking keys blanked. */
export function maskQuery(raw: string): string {
  return raw
    .split('&')
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i < 0) return pair;
      let key = pair.slice(0, i);
      try {
        key = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        /* judged as written */
      }
      return isSensitiveHeader(key) ? `${pair.slice(0, i)}=${MASK}` : pair;
    })
    .join('&');
}

/** A URL with its userinfo password and credential-looking query values blanked. */
export function maskUrl(url: string): string {
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]*)@/i, (m, scheme: string, info: string) => {
    const i = info.indexOf(':');
    return i < 0 ? m : `${scheme}${info.slice(0, i)}:${MASK}@`;
  });
  const q = out.indexOf('?');
  if (q < 0) return out;
  const hash = out.indexOf('#', q);
  const query = hash < 0 ? out.slice(q + 1) : out.slice(q + 1, hash);
  out = `${out.slice(0, q + 1)}${maskQuery(query)}${hash < 0 ? '' : out.slice(hash)}`;
  return out;
}

/** `name: value` lines with credential values blanked. */
export function maskHeaderLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const i = line.indexOf(':');
      return i > 0 && isSensitiveHeader(line.slice(0, i).trim()) ? `${line.slice(0, i)}: ${MASK}` : line;
    })
    .join('\n');
}

/** A header value with its credential blanked, keeping an auth scheme word: `Bearer •••`. */
export function maskHeaderValue(name: string, value: string): string {
  if (!isSensitiveHeader(name)) return value;
  return `${/^(bearer|basic|token|digest)\s/i.exec(value)?.[0] ?? ''}${MASK}`;
}

export function maskHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, isSensitiveHeader(k) ? MASK : v]));
}

/** Masks inside the data, never its JSON text, so a secret like `true` cannot break the JSON. */
export function maskDeep(value: unknown, secrets: string[], blankKeys = false): unknown {
  if (typeof value === 'string') return maskSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets, blankKeys));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        blankKeys && typeof v === 'string' && isSensitiveHeader(k) ? MASK : maskDeep(v, secrets, blankKeys),
      ]),
    );
  }
  return value;
}
