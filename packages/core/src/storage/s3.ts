import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { assertSafeKey } from '../paths';
import {
  ObjectExistsError,
  ObjectNotFoundError,
  type ObjectInfo,
  type ObjectStorage,
  type PutOptions,
} from './types';

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

/** S3-compatible storage (AWS S3, MinIO, R2, Backblaze B2, ...). */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.prefix = cfg.keyPrefix ? cfg.keyPrefix.replace(/^\/+|\/+$/g, '') + '/' : '';
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
    });
  }

  private k(key: string) {
    assertSafeKey(key);
    return this.prefix + key;
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions = {}): Promise<ObjectInfo> {
    if (await this.head(key)) throw new ObjectExistsError(key);
    // S3 needs a known length; artifacts are buffered per file (bounded by MAX_FILE_BYTES).
    const buf = Buffer.isBuffer(body) ? body : await streamToBuffer(body);
    const digest = createHash('sha256').update(buf).digest('hex');
    if (opts.sha256 && opts.sha256 !== digest) throw new Error(`Checksum mismatch for ${key}`);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        Body: buf,
        ContentType: opts.contentType,
        Metadata: { sha256: digest },
        // Defence in depth against concurrent writers; ignored by stores that do not support it.
        IfNoneMatch: '*',
      }),
    );
    return { key, size: buf.length, contentType: opts.contentType, sha256: digest };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      return { key, size: r.ContentLength ?? 0, contentType: r.ContentType, sha256: r.Metadata?.sha256 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
      if (!r.Body) throw new ObjectNotFoundError(key);
      return {
        body: r.Body as Readable,
        info: { key, size: r.ContentLength ?? 0, contentType: r.ContentType, sha256: r.Metadata?.sha256 },
      };
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key);
      throw err;
    }
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.k(prefix.replace(/\/+$/, '')) + '/', ContinuationToken: token }),
      );
      for (const o of r.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key.slice(this.prefix.length), size: o.Size ?? 0 });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.k(prefix.replace(/\/+$/, '')) + '/',
          Delimiter: '/',
          ContinuationToken: token,
        }),
      );
      for (const p of r.CommonPrefixes ?? []) {
        if (p.Prefix) out.push(p.Prefix.slice(this.prefix.length).replace(/\/+$/, ''));
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = prefix.replace(/\/+$/, '');
    if (!clean || !clean.includes('/')) throw new Error('Refusing to delete a top-level prefix');
    const objects = await this.list(clean);
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((o) => ({ Key: this.k(o.key) })), Quiet: true },
        }),
      );
    }
    return objects.length;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}
