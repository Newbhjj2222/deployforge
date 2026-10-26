import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGitHubSignature } from '../src/webhook';

const secret = 'whsec_test_secret';
const body = Buffer.from('{"ref":"refs/heads/main","after":"' + 'a'.repeat(40) + '"}');
const sign = (b: Uint8Array, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');

describe('GitHub webhook signature', () => {
  it('accepts a valid signature over the exact raw bytes', () => {
    expect(verifyGitHubSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects when the body differs by a single byte (e.g. re-serialised JSON)', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1));
    expect(verifyGitHubSignature(reserialised, sign(body), secret)).toBe(false);
  });

  it('rejects wrong secret, missing, malformed and wrong-algorithm headers', () => {
    expect(verifyGitHubSignature(body, sign(body, 'other'), secret)).toBe(false);
    expect(verifyGitHubSignature(body, null, secret)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha256=zzzz', secret)).toBe(false);
    expect(verifyGitHubSignature(body, 'sha1=' + 'a'.repeat(40), secret)).toBe(false);
    expect(verifyGitHubSignature(body, sign(body), '')).toBe(false);
  });
});
