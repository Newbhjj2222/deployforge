import 'server-only';
import { Redis } from 'ioredis';
import { AppError } from '@deployforge/core';
import { config } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __df_redis: Redis | undefined;
}

export function redis(): Redis {
  return (globalThis.__df_redis ??= new Redis(config().REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false, enableOfflineQueue: false }));
}

/**
 * Fixed-window rate limiter on Redis (atomic INCR + EXPIRE).
 * Fails CLOSED for sensitive buckets (auth) and OPEN for the rest if Redis is unavailable, so an outage
 * of the limiter cannot lock every user out of the dashboard but can never open a brute-force window.
 */
export async function rateLimit(bucket: string, key: string, limit: number, windowSec: number, opts: { failClosed?: boolean } = {}): Promise<void> {
  const k = `rl:${bucket}:${key}`;
  try {
    const r = redis();
    const n = await r.incr(k);
    if (n === 1) await r.expire(k, windowSec);
    if (n > limit) {
      const ttl = await r.ttl(k);
      throw new AppError('rate_limited', `Too many requests. Try again in ${Math.max(ttl, 1)}s.`);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (opts.failClosed) throw new AppError('rate_limited', 'Service temporarily unavailable. Please try again shortly.');
  }
}

export function clientIp(headers: Headers): string {
  // Behind Caddy the first X-Forwarded-For hop is the client. Only trust it when TRUST_PROXY=true.
  if (process.env.TRUST_PROXY === 'true') {
    const xff = headers.get('x-forwarded-for');
    if (xff) return xff.split(',')[0]!.trim().slice(0, 64);
  }
  return headers.get('x-real-ip')?.slice(0, 64) ?? 'unknown';
}
