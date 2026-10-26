import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ObjectNotFoundError,
  filesKey,
  isHashedAsset,
  readManifest,
  resolveRequestPath,
  type Manifest,
  type ObjectStorage,
} from '@deployforge/core';

/** Artifacts are immutable, so a manifest never changes once its prefix exists: cache it for good (bounded). */
const manifests = new Map<string, Manifest>();
const MAX_MANIFESTS = 200;

async function manifestFor(storage: ObjectStorage, prefix: string): Promise<Manifest> {
  const hit = manifests.get(prefix);
  if (hit) return hit;
  const m = await readManifest(storage, prefix);
  if (manifests.size >= MAX_MANIFESTS) manifests.delete(manifests.keys().next().value as string);
  manifests.set(prefix, m);
  return m;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'interest-cohort=()',
};

export function plain(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

/**
 * Serve a request from a static deployment's manifest. Only paths listed in the manifest can ever be
 * served, so there is no filesystem path to traverse: ".." / encoded / hidden paths are rejected by
 * resolveRequestPath before the lookup, and unknown keys simply 404.
 */
export async function serveStatic(
  storage: ObjectStorage,
  prefix: string,
  spaFallback: boolean,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS });
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const wanted = resolveRequestPath(url.pathname);
  if (!wanted) return plain(res, 404, 'Not found');

  const manifest = await manifestFor(storage, prefix);
  const index = new Map(manifest.files.map((f) => [f.path, f]));
  let file = index.get(wanted);
  let status = 200;
  if (!file) {
    // "/about" -> "about.html" or "about/index.html"
    file = index.get(`${wanted}.html`) ?? index.get(`${wanted}/index.html`);
  }
  if (!file && spaFallback && !/\.[a-z0-9]{1,8}$/i.test(wanted)) {
    file = index.get('index.html'); // client-side routing: only for extension-less paths
  }
  if (!file) {
    const nf = index.get('404.html');
    if (!nf) return plain(res, 404, 'Not found');
    file = nf;
    status = 404;
  }

  const etag = `"${file.sha256.slice(0, 32)}"`;
  const immutable = status === 200 && isHashedAsset(file.path) && !file.path.endsWith('.html');
  const headers: Record<string, string> = {
    'content-type': file.contentType,
    'content-length': String(file.size),
    etag,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    ...SECURITY_HEADERS,
  };
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': headers['cache-control']!, ...SECURITY_HEADERS });
    res.end();
    return;
  }
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    const { body } = await storage.get(filesKey(prefix, file.path));
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) res.destroy(); // headers already sent; manifest/object mismatch
    else throw err;
  }
}
