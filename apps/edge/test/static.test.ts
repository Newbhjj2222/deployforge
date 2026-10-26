import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalStorage, buildStaticManifest, contentTypeFor, filesKey, manifestKey } from '@deployforge/core';
import { serveStatic } from '../src/static';

let dir: string;
let storage: LocalStorage;
let server: http.Server;
let port: number;
// prefixes are immutable in production, so the edge caches manifests per prefix: use a fresh one per test
let PREFIX = '';
let n = 0;

async function publish(files: Record<string, string>, spa = false) {
  const entries = [];
  for (const [p, c] of Object.entries(files)) {
    const buf = Buffer.from(c);
    const sha = createHash('sha256').update(buf).digest('hex');
    await storage.put(filesKey(PREFIX, p), buf, { sha256: sha });
    entries.push({ path: p, size: buf.length, sha256: sha, contentType: contentTypeFor(p) });
  }
  await storage.put(manifestKey(PREFIX), Buffer.from(JSON.stringify(buildStaticManifest(entries, spa))));
  return spa;
}

const get = (p: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end();
  });

/** send a raw request line so the client library cannot normalise ".." for us */
const raw = (requestLine: string) =>
  new Promise<string>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = '';
    s.on('data', (c) => (out += c));
    s.on('end', () => resolve(out));
    s.on('error', () => resolve(out));
  });

beforeEach(async () => {
  PREFIX = `deployments/p1/d${++n}/a1`;
  dir = await mkdtemp(path.join(tmpdir(), 'df-edge-'));
  storage = new LocalStorage(dir);
  await storage.put('secrets/other-tenant.txt', Buffer.from('TOP SECRET'));
});
afterEach(async () => {
  server.closeAllConnections(); // keep-alive client sockets would otherwise block close()
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const start = async (spa: boolean) => {
  server = http.createServer((req, res) => void serveStatic(storage, PREFIX, spa, req, res).catch(() => res.destroy()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
};

describe('static serving', () => {
  it('serves index, assets with correct types and cache headers, and supports conditional requests', async () => {
    await publish({ 'index.html': '<h1>Hello</h1>', 'assets/app.js': 'console.log(1)', 'about.html': 'about' });
    await start(false);
    const home = await get('/');
    expect(home.status).toBe(200);
    expect(home.body).toBe('<h1>Hello</h1>');
    expect(home.headers['content-type']).toContain('text/html');
    expect(home.headers['cache-control']).toContain('must-revalidate');
    expect(home.headers['x-content-type-options']).toBe('nosniff');
    const js = await get('/assets/app.js');
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    const again = await get('/assets/app.js', { 'if-none-match': js.headers.etag as string });
    expect(again.status).toBe(304);
    expect((await get('/about')).body).toBe('about'); // clean URLs
    expect((await get('/', {}, 'HEAD')).body).toBe('');
  });

  it('404s unknown paths and rejects non-GET methods', async () => {
    await publish({ 'index.html': 'x' });
    await start(false);
    expect((await get('/missing')).status).toBe(404);
    expect((await get('/', {}, 'POST')).status).toBe(405);
  });

  it('SPA fallback applies to extension-less paths only', async () => {
    await publish({ 'index.html': '<div id=root>', 'app.js': 'x' }, true);
    await start(true);
    expect((await get('/dashboard/settings')).body).toBe('<div id=root>');
    expect((await get('/missing.js')).status).toBe(404);
  });

  it('serves a custom 404.html with status 404', async () => {
    await publish({ 'index.html': 'x', '404.html': 'custom not found' });
    await start(false);
    const r = await get('/nope');
    expect(r.status).toBe(404);
    expect(r.body).toBe('custom not found');
  });

  it('cannot be used to read files outside the deployment (traversal, encodings, hidden files)', async () => {
    await publish({ 'index.html': 'x' });
    await start(false);
    const attempts = [
      'GET /../../../secrets/other-tenant.txt HTTP/1.1',
      'GET /..%2f..%2f..%2fsecrets%2fother-tenant.txt HTTP/1.1',
      'GET /%2e%2e/%2e%2e/secrets/other-tenant.txt HTTP/1.1',
      'GET /files/../../../../secrets/other-tenant.txt HTTP/1.1',
      'GET /manifest.json HTTP/1.1',
      'GET /.env HTTP/1.1',
      'GET /%00 HTTP/1.1',
      'GET /..%5c..%5csecrets/other-tenant.txt HTTP/1.1',
    ];
    for (const a of attempts) {
      const out = await raw(a);
      expect(out.includes('TOP SECRET'), a).toBe(false);
      expect(/^HTTP\/1\.1 (404|400)/.test(out), `${a} -> ${out.split('\r\n')[0]}`).toBe(true);
    }
  });
});
