import { hash, verify } from '@node-rs/argon2';

// Argon2id with OWASP-recommended minimums (19 MiB, t=2, p=1).
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 /* Argon2id */ } as const;

export const hashPassword = (plain: string) => hash(plain, OPTS);

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burn the same CPU as a real verification so unknown accounts are not distinguishable by timing. */
export async function equaliseTiming(plain: string): Promise<void> {
  dummyHash ??= hashPassword('deployforge-timing-equaliser');
  await verifyPassword(await dummyHash, plain);
}

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
