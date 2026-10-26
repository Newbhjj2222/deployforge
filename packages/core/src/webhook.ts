import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the EXACT raw request bytes.
 * Never pass a re-serialised JSON body here.
 */
export function verifyGitHubSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);
