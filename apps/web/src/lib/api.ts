import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { AppError, toErrorBody } from '@deployforge/core';
import { auth } from '@/auth';
import { clientIp, rateLimit } from './ratelimit';

export interface Ctx<P = Record<string, string>> {
  req: NextRequest;
  userId: string;
  params: P;
  ip: string;
}

type RouteCtx = { params: Promise<Record<string, string>> };

const MAX_JSON_BYTES = 256 * 1024;

/**
 * Wrap a route handler: authenticate, rate limit, translate errors into the consistent error body.
 * Authorization is performed by the handler through `requireProject` & co. so it is impossible to
 * forget: handlers receive `userId` only, never a project object they did not authorise.
 */
export function api<P = Record<string, string>>(
  handler: (ctx: Ctx<P>) => Promise<Response | object | null>,
  opts: { limit?: number; windowSec?: number; bucket?: string } = {},
) {
  return async (req: NextRequest, routeCtx: RouteCtx) => {
    try {
      const session = await auth();
      const userId = session?.user?.id;
      if (!userId) throw new AppError('unauthenticated', 'Sign in required');
      const ip = clientIp(req.headers);
      await rateLimit(opts.bucket ?? 'api', userId, opts.limit ?? 240, opts.windowSec ?? 60);
      const params = (await routeCtx.params) as P;
      const out = await handler({ req, userId, params, ip });
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { 'cache-control': 'no-store' } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Invalid request', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } },
      { status: 422 },
    );
  }
  const { status, body } = toErrorBody(err);
  if (status >= 500) console.error('[api] unhandled error:', err instanceof Error ? err.stack : err);
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** Parse a JSON body with a hard size limit and a Zod schema. */
export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_JSON_BYTES) throw new AppError('payload_too_large', 'Request body too large');
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new AppError('bad_request', 'Content-Type must be application/json');
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new AppError('payload_too_large', 'Request body too large');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError('bad_request', 'Malformed JSON');
  }
  return schema.parse(json);
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): z.infer<S> {
  return schema.parse(Object.fromEntries(new URL(req.url).searchParams));
}

/** BigInt-safe JSON (Prisma BigInt columns). */
export const serialize = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
