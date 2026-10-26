import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, needsRotation, parseKeyring, safeEqual } from '../src/crypto';

const k = () => randomBytes(32).toString('base64');

describe('encryption', () => {
  const ring = parseKeyring(`1:${k()}`, 1);

  it('round-trips and never stores plaintext in the envelope', () => {
    const { value } = encrypt('super-secret-value', ring, 'p1:API_KEY:PRODUCTION');
    expect(value.startsWith('v1.1.')).toBe(true);
    expect(value).not.toContain('super-secret-value');
    expect(decrypt(value, ring, 'p1:API_KEY:PRODUCTION')).toBe('super-secret-value');
  });

  it('uses a fresh IV each time', () => {
    const a = encrypt('x'.repeat(10), ring, 'aad').value;
    const b = encrypt('x'.repeat(10), ring, 'aad').value;
    expect(a).not.toBe(b);
  });

  it('rejects ciphertext moved to another record (AAD binding)', () => {
    const { value } = encrypt('hello-world', ring, 'p1:A:PRODUCTION');
    expect(() => decrypt(value, ring, 'p2:A:PRODUCTION')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const { value } = encrypt('hello-world', ring, 'aad');
    const parts = value.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), ring, 'aad')).toThrow();
  });

  it('supports key rotation', () => {
    const k1 = k();
    const old = parseKeyring(`1:${k1}`, 1);
    const ct = encrypt('rotate-me-please', old, 'aad').value;
    const next = parseKeyring(`1:${k1},2:${k()}`, 2);
    expect(decrypt(ct, next, 'aad')).toBe('rotate-me-please');
    expect(needsRotation(ct, next)).toBe(true);
    const re = encrypt(decrypt(ct, next, 'aad'), next, 'aad').value;
    expect(needsRotation(re, next)).toBe(false);
  });

  it('validates key material', () => {
    expect(() => parseKeyring('1:c2hvcnQ=', 1)).toThrow(/32 bytes/);
    expect(() => parseKeyring(`1:${k()}`, 2)).toThrow(/not in ENCRYPTION_KEYS/);
  });

  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
