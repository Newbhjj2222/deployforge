import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalStorage } from '../src/storage/local';
import { ObjectExistsError, ObjectNotFoundError } from '../src/storage/types';
import {
  buildStaticManifest,
  filesKey,
  manifestChecksum,
  manifestKey,
  validateArtifact,
} from '../src/storage/manifest';

let dir: string;
let storage: LocalStorage;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'df-storage-'));
  storage = new LocalStorage(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const read = async (key: string) => {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

describe('LocalStorage', () => {
  it('stores, reads, heads and lists objects', async () => {
    const body = Buffer.from('hello');
    const info = await storage.put('deployments/d1/a1/files/index.html', body, { contentType: 'text/html', sha256: sha(body) });
    expect(info.size).toBe(5);
    expect((await read('deployments/d1/a1/files/index.html')).toString()).toBe('hello');
    expect((await storage.head('deployments/d1/a1/files/index.html'))?.contentType).toBe('text/html');
    expect((await storage.list('deployments/d1')).map((o) => o.key)).toEqual(['deployments/d1/a1/files/index.html']);
  });

  it('is immutable: refuses to overwrite', async () => {
    await storage.put('a/b/c.txt', Buffer.from('1'));
    await expect(storage.put('a/b/c.txt', Buffer.from('2'))).rejects.toBeInstanceOf(ObjectExistsError);
    expect((await read('a/b/c.txt')).toString()).toBe('1');
  });

  it('verifies checksums and leaves no partial object behind', async () => {
    await expect(storage.put('a/b/bad.txt', Buffer.from('x'), { sha256: 'f'.repeat(64) })).rejects.toThrow(/Checksum/);
    expect(await storage.head('a/b/bad.txt')).toBeNull();
  });

  it('rejects traversal keys', async () => {
    await expect(storage.put('../escape.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(storage.put('a/../../escape.txt', Buffer.from('x'))).rejects.toThrow();
    await expect(storage.get('/etc/passwd')).rejects.toThrow();
  });

  it('throws not found and deletes prefixes (but never a top-level one)', async () => {
    await expect(storage.get('nope/x')).rejects.toBeInstanceOf(ObjectNotFoundError);
    await storage.put('deployments/d1/a1/x', Buffer.from('1'));
    await storage.put('deployments/d1/a2/y', Buffer.from('2'));
    expect(await storage.listPrefixes('deployments/d1')).toEqual(['deployments/d1/a1', 'deployments/d1/a2']);
    expect(await storage.deletePrefix('deployments/d1/a1')).toBe(1);
    expect(await storage.head('deployments/d1/a1/x')).toBeNull();
    expect(await storage.head('deployments/d1/a2/y')).not.toBeNull();
    await expect(storage.deletePrefix('deployments')).rejects.toThrow();
  });
});

describe('artifact manifest validation', () => {
  const publish = async (prefix: string, files: Record<string, string>, tamper?: (m: ReturnType<typeof buildStaticManifest>) => void) => {
    const entries = [];
    for (const [p, c] of Object.entries(files)) {
      const buf = Buffer.from(c);
      await storage.put(filesKey(prefix, p), buf, { sha256: sha(buf) });
      entries.push({ path: p, size: buf.length, sha256: sha(buf), contentType: 'text/plain' });
    }
    const m = buildStaticManifest(entries, false);
    const checksum = manifestChecksum(m);
    tamper?.(m);
    await storage.put(manifestKey(prefix), Buffer.from(JSON.stringify(m)));
    return checksum;
  };

  it('accepts a complete static artifact', async () => {
    const checksum = await publish('deployments/d1/a1', { 'index.html': '<h1>x</h1>', 'a.css': 'b{}' });
    const m = await validateArtifact(storage, 'deployments/d1/a1', checksum);
    expect(m.files).toHaveLength(2);
  });

  it('rejects artifacts without index.html', async () => {
    const checksum = await publish('deployments/d2/a1', { 'about.html': 'x' });
    await expect(validateArtifact(storage, 'deployments/d2/a1', checksum)).rejects.toThrow(/index\.html/);
  });

  it('rejects a manifest whose checksum differs from the recorded one', async () => {
    await publish('deployments/d3/a1', { 'index.html': 'x' });
    await expect(validateArtifact(storage, 'deployments/d3/a1', 'f'.repeat(64))).rejects.toThrow(/checksum/);
  });

  it('rejects manifests with unsafe paths', () => {
    expect(() => buildStaticManifest([{ path: '../x', size: 1, sha256: 'a'.repeat(64), contentType: 't' }], false)).toThrow();
    expect(() => buildStaticManifest([{ path: 'a', size: 1, sha256: 'a'.repeat(64), contentType: 't' }, { path: 'a', size: 1, sha256: 'a'.repeat(64), contentType: 't' }], false)).toThrow(/Duplicate/);
  });

  it('rejects missing objects', async () => {
    const checksum = await publish('deployments/d4/a1', { 'index.html': 'x', 'b.js': 'y' });
    await rm(path.join(dir, 'deployments/d4/a1/files/b.js'));
    await expect(validateArtifact(storage, 'deployments/d4/a1', checksum)).rejects.toThrow(/Missing/);
  });
});
