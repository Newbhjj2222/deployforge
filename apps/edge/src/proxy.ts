import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { SECURITY_HEADERS, plain } from './static';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const MAX_BODY = 10 * 1024 * 1024;

/**
 * Reverse proxy to a Python runtime container on the private runtime network.
 * The upstream host is always `df-rt-<deploymentId>` built from a database id (never from the request),
 * so a client cannot steer the proxy to another internal address.
 */
export function proxyToRuntime(deploymentId: string, port: number, req: IncomingMessage, res: ServerResponse, clientIp: string | undefined): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deploymentId)) return plain(res, 502, 'Bad gateway');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) return plain(res, 413, 'Payload too large');

  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], clientIp].filter(Boolean).join(', ');
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';

  const upstream = http.request(
    { host: `df-rt-${deploymentId}`, port, method: req.method, path: req.url, headers, timeout: 30_000 },
    (up) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) out[k] ??= v;
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    },
  );
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) plain(res, 502, 'The application is not responding');
    else res.destroy();
  });
  let received = 0;
  req.on('data', (c: Buffer) => {
    received += c.length;
    if (received > MAX_BODY) {
      upstream.destroy();
      if (!res.headersSent) plain(res, 413, 'Payload too large');
    }
  });
  req.pipe(upstream);
}
