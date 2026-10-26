import { describe, expect, it } from 'vitest';
import {
  UnsafePathError,
  assertSafeKey,
  resolveRequestPath,
  safeJoin,
  validateArtifactPath,
  validateRelativeDir,
} from '../src/paths';

describe('artifact path validation', () => {
  it('accepts normal paths', () => {
    for (const p of ['index.html', 'assets/app.123.js', '.well-known/security.txt', 'a/b/c.css']) {
      expect(validateArtifactPath(p)).toBe(p);
    }
  });

  it('rejects traversal, absolute, hidden, control and odd paths', () => {
    const bad = ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a\\b', '.env', 'a/.git/config', 'a\u0000b', 'C:/x', 'a/'];
    for (const p of bad) expect(() => validateArtifactPath(p), JSON.stringify(p)).toThrow(UnsafePathError);
  });

  it('rejects over-long paths', () => {
    expect(() => validateArtifactPath('a'.repeat(2000))).toThrow();
    expect(() => validateArtifactPath('a'.repeat(300))).toThrow();
  });
});

describe('safeJoin', () => {
  it('stays inside root', () => {
    expect(safeJoin('/data', 'a/b.txt')).toBe('/data/a/b.txt');
    expect(() => safeJoin('/data', '../etc/passwd')).toThrow();
    expect(() => safeJoin('/data', 'a/../../etc')).toThrow();
    expect(() => safeJoin('/data', '/etc/passwd')).toThrow(); // absolute paths escape the root
  });
});

describe('request path resolution', () => {
  it('maps URLs to manifest keys', () => {
    expect(resolveRequestPath('/')).toBe('index.html');
    expect(resolveRequestPath('/docs/')).toBe('docs/index.html');
    expect(resolveRequestPath('/a/b.css')).toBe('a/b.css');
    expect(resolveRequestPath('/caf%C3%A9.txt')).toBe('café.txt');
  });

  it('refuses traversal in every encoding and hidden files', () => {
    for (const p of ['/../x', '/a/../../b', '/%2e%2e/x', '/a/%2e%2e/%2e%2e/b', '/%2e%2e%2fx', '/a%5c..%5cb', '/.env', '/a/.git/HEAD', '/%00', '/%zz', 'noslash']) {
      expect(resolveRequestPath(p), p).toBeNull();
    }
    expect(resolveRequestPath('/.well-known/acme')).toBe('.well-known/acme');
  });
});

describe('storage keys and dirs', () => {
  it('rejects unsafe storage keys', () => {
    for (const k of ['', '/abs', 'a/../b', 'a//b', 'a\\b']) expect(() => assertSafeKey(k)).toThrow();
    expect(() => assertSafeKey('deployments/abc/a1/manifest.json')).not.toThrow();
  });

  it('validates relative dirs', () => {
    expect(validateRelativeDir('./dist/')).toBe('dist');
    expect(validateRelativeDir('.')).toBe('');
    expect(() => validateRelativeDir('../x')).toThrow();
    expect(() => validateRelativeDir('/etc')).toThrow();
    expect(() => validateRelativeDir('a/../b')).toThrow();
  });
});
