/**
 * WebSocket proxy — the browser can't set custom headers (Authorization) on a
 * WebSocket, and can't do wss with odd certs. So the browser connects to us and
 * we open the REAL ws:// / wss:// connection with the requested headers, then
 * pipe both directions.
 *
 * Client:  ws://<conduit>/api/ws/proxy?target=<enc>&headers=<b64json>&protocols=<csv>
 * Frames the browser receives are JSON envelopes:
 *   {kind:'open'}                          — upstream connected
 *   {kind:'message', at, data}             — a message from the server
 *   {kind:'close', code, reason}           — upstream closed
 *   {kind:'error', error}                  — upstream error
 * Anything the browser SENDS is forwarded verbatim to the upstream server.
 */
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export function attachWs(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/ws/proxy')) return; // let other upgrades pass
    wss.handleUpgrade(req, socket, head, (client) => relay(client, url));
  });
}

function relay(client: WebSocket, reqUrl: string) {
  const q = new URL(reqUrl, 'http://x').searchParams;
  const target = q.get('target') ?? '';
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(Buffer.from(q.get('headers') ?? '', 'base64').toString('utf8') || '{}');
  } catch {
    /* no headers */
  }
  const protocols = (q.get('protocols') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const send = (obj: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
  };

  if (!/^wss?:\/\//i.test(target)) {
    send({ kind: 'error', error: 'target must start with ws:// or wss://' });
    client.close();
    return;
  }

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(target, protocols.length ? protocols : undefined, { headers });
  } catch (e: any) {
    send({ kind: 'error', error: String(e?.message ?? e) });
    client.close();
    return;
  }

  upstream.on('open', () => send({ kind: 'open' }));
  upstream.on('message', (data, isBinary) =>
    send({
      kind: 'message',
      at: new Date().toISOString(),
      data: isBinary ? `[binary ${(data as Buffer).length} bytes]` : data.toString(),
    }),
  );
  upstream.on('close', (code, reason) => {
    send({ kind: 'close', code, reason: reason.toString() });
    client.close();
  });
  upstream.on('error', (e) => {
    send({ kind: 'error', error: String(e?.message ?? e) });
    // a lone 'error' not followed by 'close' would otherwise leak the client socket
    client.close();
  });

  // browser → upstream (verbatim)
  client.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
  });
  client.on('close', () => upstream.close());
  client.on('error', () => upstream.close());
}
