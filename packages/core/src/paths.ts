import path from 'node:path';

/**
 * Path safety helpers. Two distinct jobs:
 *  1. validateArtifactPath - decide whether a path produced by a build may become an artifact key.
 *  2. resolveRequestPath   - map an HTTP request path onto an artifact manifest key.
 * Neither ever touches the filesystem; manifests are the only thing that can be served.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Hidden files (except .well-known) are never published: they are very often leaked secrets. */
const isHiddenSegment = (seg: string) => seg.startsWith('.') && seg !== '.well-known';

export function validateArtifactPath(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new UnsafePathError('empty path');
  if (rel.length > MAX_PATH_LENGTH) throw new UnsafePathError('path too long');
  if (CONTROL.test(rel)) throw new UnsafePathError('control characters in path');
  if (rel.includes('\\')) throw new UnsafePathError('backslash in path');
  if (rel.startsWith('/')) throw new UnsafePathError('absolute path');
  if (/^[a-zA-Z]:/.test(rel)) throw new UnsafePathError('drive-letter path');
  if (rel.normalize('NFC') !== rel) throw new UnsafePathError('path is not NFC normalised');
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '' ) throw new UnsafePathError('empty path segment');
    if (seg === '.' || seg === '..') throw new UnsafePathError('relative path segment');
    if (seg.length > MAX_SEGMENT_LENGTH) throw new UnsafePathError('path segment too long');
    if (isHiddenSegment(seg)) throw new UnsafePathError('hidden path segment');
  }
  return rel;
}

/** Join `rel` onto `root` and prove the result stays inside `root`. */
export function safeJoin(root: string, rel: string): string {
  if (CONTROL.test(rel) || rel.includes('\0')) throw new UnsafePathError('control characters in path');
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel);
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new UnsafePathError('path escapes root');
  }
  return target;
}

/**
 * Convert an HTTP request path (already stripped of the query string) into the manifest key it
 * refers to. Returns null for anything suspicious; callers answer 404 (never 500).
 *  "/" -> "index.html", "/docs/" -> "docs/index.html", "/a.css" -> "a.css"
 */
export function resolveRequestPath(urlPath: string): string | null {
  if (urlPath.length > MAX_PATH_LENGTH || !urlPath.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (CONTROL.test(decoded) || decoded.includes('\\')) return null;
  let rel = decoded.replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (isHiddenSegment(seg)) return null;
  }
  return rel.normalize('NFC');
}

/** Validate an object-storage key (used by both storage drivers). */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 1500) throw new UnsafePathError('invalid storage key');
  if (CONTROL.test(key) || key.includes('\\') || key.startsWith('/')) {
    throw new UnsafePathError('invalid storage key');
  }
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new UnsafePathError('invalid storage key');
  }
}

/** Validate a user supplied relative directory (rootDirectory / outputDirectory). */
export function validateRelativeDir(dir: string): string {
  const cleaned = dir.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned === '.') return '';
  if (CONTROL.test(cleaned) || cleaned.includes('\\') || cleaned.startsWith('/')) {
    throw new UnsafePathError('invalid directory');
  }
  for (const seg of cleaned.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new UnsafePathError('invalid directory');
  }
  if (cleaned.length > 200) throw new UnsafePathError('directory too long');
  return cleaned;
}
