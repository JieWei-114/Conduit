export function joinUrl(base: string, ...parts: string[]): string {
  const head = base.trim().replace(/\/+$/, '');
  const tail = parts
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return tail ? `${head}/${tail}` : head;
}

export function appendQuery(url: string, query: string): string {
  if (!query) return url;
  const hash = url.indexOf('#');
  const head = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : '';
  const sep = !head.includes('?') ? '?' : /[?&]$/.test(head) ? '' : '&';
  return `${head}${sep}${query}${frag}`;
}
