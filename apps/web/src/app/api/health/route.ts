import { NextResponse } from 'next/server';
import { prisma } from '@deployforge/db';
import { redis } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/** Liveness + dependency readiness. Reveals only ok/fail per dependency, never error details. */
export async function GET() {
  const checks: Record<string, 'ok' | 'fail'> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'fail';
  }
  try {
    checks.redis = (await redis().ping()) === 'PONG' ? 'ok' : 'fail';
  } catch {
    checks.redis = 'fail';
  }
  const ok = Object.values(checks).every((v) => v === 'ok');
  return NextResponse.json({ status: ok ? 'ok' : 'degraded', checks }, { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
