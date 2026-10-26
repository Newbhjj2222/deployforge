import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { assertSafeKey, safeJoin } from '../paths';
import {
  ObjectExistsError,
  ObjectNotFoundError,
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
} from './types';

/**
 * Local filesystem storage. DEVELOPMENT ONLY - single host, no replication, no access control
 * beyond filesystem permissions. Writes are atomic (temp file + rename) and never overwrite.
 * Metadata lives in a `<file>.meta.json` sidecar so that content types survive restarts.
 */
export class LocalStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private fileFor(key: string): string {
    assertSafeKey(key);
    return safeJoin(this.root, key);
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions = {}): Promise<ObjectInfo> {
    const file = this.fileFor(key);
    if (await this.exists(file)) throw new ObjectExistsError(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    try {
      const src = Buffer.isBuffer(body) ? Readable.from([body]) : body;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      await pipeline(src, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o640 }));
      const digest = hash.digest('hex');
      if (opts.sha256 && opts.sha256 !== digest) {
        throw new Error(`Checksum mismatch for ${key}`);
      }
      // rename() overwrites silently on POSIX; the pre-check above plus unique per-attempt prefixes
      // make collisions a bug, and the worker treats ObjectExistsError as a hard error.
      await rename(tmp, file);
      const info: ObjectInfo = { key, size, contentType: opts.contentType, sha256: digest };
      await writeFile(`${file}.meta.json`, JSON.stringify({ contentType: opts.contentType, sha256: digest }), { mode: 0o640 });
      return info;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async exists(file: string): Promise<boolean> {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const file = this.fileFor(key);
    try {
      const st = await stat(file);
      if (!st.isFile()) return null;
      let meta: { contentType?: string; sha256?: string } = {};
      try {
        meta = JSON.parse(await readFile(`${file}.meta.json`, 'utf8'));
      } catch {
        /* sidecar optional */
      }
      return { key, size: st.size, contentType: meta.contentType, sha256: meta.sha256 };
    } catch {
      return null;
    }
  }

  async get(key: string) {
    const info = await this.head(key);
    if (!info) throw new ObjectNotFoundError(key);
    return { body: createReadStream(this.fileFor(key)), info };
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const dir = this.fileFor(prefix.replace(/\/+$/, ''));
    const out: ObjectInfo[] = [];
    const walk = async (d: string) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && !e.name.endsWith('.meta.json') && !e.name.endsWith('.tmp')) {
          const key = path.relative(this.root, full).split(path.sep).join('/');
          const info = await this.head(key);
          if (info) out.push(info);
        }
      }
    };
    await walk(dir);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    const dir = this.fileFor(prefix.replace(/\/+$/, ''));
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const base = prefix.replace(/\/+$/, '');
      return entries.filter((e) => e.isDirectory()).map((e) => `${base}/${e.name}`);
    } catch {
      return [];
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = prefix.replace(/\/+$/, '');
    if (!clean || !clean.includes('/')) throw new Error('Refusing to delete a top-level prefix');
    const objects = await this.list(clean);
    await rm(this.fileFor(clean), { recursive: true, force: true });
    return objects.length;
  }
}
