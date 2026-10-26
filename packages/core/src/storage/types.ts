import type { Readable } from 'node:stream';

export interface PutOptions {
  contentType?: string;
  /** Hex sha256 of the content; stored as metadata and verified by implementations that can. */
  sha256?: string;
}

export interface ObjectInfo {
  key: string;
  size: number;
  contentType?: string;
  sha256?: string;
}

/**
 * Object storage abstraction. Artifacts are immutable: `put` fails with ObjectExistsError when
 * the key already exists (use a new prefix per build attempt instead of overwriting).
 */
export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  put(key: string, body: Buffer | Readable, opts?: PutOptions): Promise<ObjectInfo>;
  get(key: string): Promise<{ body: Readable; info: ObjectInfo }>;
  head(key: string): Promise<ObjectInfo | null>;
  list(prefix: string): Promise<ObjectInfo[]>;
  deletePrefix(prefix: string): Promise<number>;
  /** Lowest-level listing of immediate "directories" under a prefix, used by the cleanup job. */
  listPrefixes(prefix: string): Promise<string[]>;
}

export class ObjectExistsError extends Error {
  constructor(key: string) {
    super(`Object already exists: ${key}`);
    this.name = 'ObjectExistsError';
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}
