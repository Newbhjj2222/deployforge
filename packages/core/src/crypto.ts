import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (all base64url).
 * AES-256-GCM with a random 96-bit IV per message. Associated data binds the ciphertext to
 * the record it belongs to so values cannot be swapped between rows.
 *
 * Keys live in the environment (or a KMS-backed secret), never in the database:
 *   ENCRYPTION_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>"
 *   ENCRYPTION_KEY_ACTIVE=2
 * Old keys stay in the ring for decryption until every row has been re-encrypted.
 */
export interface Keyring {
  keys: Map<number, Buffer>;
  activeId: number;
}

export function parseKeyring(keysSpec: string, activeId: number): Keyring {
  const keys = new Map<number, Buffer>();
  for (const part of keysSpec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx < 1) throw new Error('ENCRYPTION_KEYS entries must look like "<id>:<base64 key>"');
    const id = Number(part.slice(0, idx));
    if (!Number.isInteger(id) || id < 1) throw new Error('Encryption key ids must be positive integers');
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (key.length !== 32) throw new Error(`Encryption key ${id} must decode to exactly 32 bytes`);
    if (keys.has(id)) throw new Error(`Duplicate encryption key id ${id}`);
    keys.set(id, key);
  }
  if (!keys.has(activeId)) throw new Error(`Active encryption key id ${activeId} is not in ENCRYPTION_KEYS`);
  return { keys, activeId };
}

const b64u = (b: Buffer) => b.toString('base64url');

export function encrypt(plaintext: string, ring: Keyring, aad: string): { value: string; keyId: number } {
  const key = ring.keys.get(ring.activeId);
  if (!key) throw new Error('Active encryption key missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    value: ['v1', String(ring.activeId), b64u(iv), b64u(tag), b64u(ct)].join('.'),
    keyId: ring.activeId,
  };
}

export function decrypt(envelope: string, ring: Keyring, aad: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
  const keyId = Number(parts[1]);
  const key = ring.keys.get(keyId);
  if (!key) throw new Error(`Encryption key ${keyId} is not available`);
  const iv = Buffer.from(parts[2]!, 'base64url');
  const tag = Buffer.from(parts[3]!, 'base64url');
  const ct = Buffer.from(parts[4]!, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when the stored ciphertext was produced with a key other than the active one. */
export function needsRotation(envelope: string, ring: Keyring): boolean {
  const keyId = Number(envelope.split('.')[1]);
  return keyId !== ring.activeId;
}

export const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export const hmacSha256Hex = (secret: string | Buffer, data: string | Uint8Array) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time string comparison that does not leak length through early exit on equal-length input. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // still do a comparison so timing does not depend on where the mismatch is
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomHex = (bytes = 4) => randomBytes(bytes).toString('hex');
