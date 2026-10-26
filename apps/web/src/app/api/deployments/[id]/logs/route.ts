import { isTerminal, type DeploymentStatus } from '@deployforge/core';
import { prisma, requireDeployment } from '@deployforge/db';
import { auth } from '@/auth';
import { errorResponse, serialize } from '@/lib/api';
import { rateLimit } from '@/lib/ratelimit';
import { AppError } from '@deployforge/core';

export const dynamic = 'force-dynamic';

const toDto = (l: { seq: number; ts: Date; level: string; stream: string; message: string }) => ({ seq: l.seq, ts: l.ts, level: l.level, stream: l.stream, message: l.message });

/**
 * GET /api/deployments/:id/logs
 *   ?after=<seq>&limit=<n>          JSON page of log lines (polling / history)
 *   Accept: text/event-stream       Server-Sent Events: replays from `after` (or Last-Event-ID), then follows live.
 * Logs are already redacted when written; this route only ever reads them.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) throw new AppError('unauthenticated', 'Sign in required');
    const userId = session.user.id;
    const { id } = await ctx.params;
    await requireDeployment(userId, id);
    const url = new URL(req.url);
    const wantsStream = (req.headers.get('accept') ?? '').includes('text/event-stream');
    const afterParam = Number(req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? -1);
    let after = Number.isFinite(afterParam) ? afterParam : -1;

    if (!wantsStream) {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 500) || 500, 1), 2000);
      const [logs, dep] = await Promise.all([
        prisma.deploymentLog.findMany({ where: { deploymentId: id, seq: { gt: after } }, orderBy: { seq: 'asc' }, take: limit }),
        prisma.deployment.findUniqueOrThrow({ where: { id }, select: { status: true } }),
      ]);
      return Response.json(serialize({ logs: logs.map(toDto), status: dep.status, done: isTerminal(dep.status as DeploymentStatus) }), { headers: { 'cache-control': 'no-store' } });
    }

    await rateLimit('sse', userId, 30, 60);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown, idNum?: number) =>
          controller.enqueue(encoder.encode(`${idNum !== undefined ? `id: ${idNum}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const started = Date.now();
        let lastStatus = '';
        let closed = false;
        req.signal.addEventListener('abort', () => (closed = true));
        controller.enqueue(encoder.encode('retry: 2000\n\n'));
        try {
          while (!closed && Date.now() - started < 10 * 60_000) {
            const [logs, dep] = await Promise.all([
              prisma.deploymentLog.findMany({ where: { deploymentId: id, seq: { gt: after } }, orderBy: { seq: 'asc' }, take: 500 }),
              prisma.deployment.findUnique({ where: { id }, select: { status: true, progress: true, failureReason: true } }),
            ]);
            if (!dep) break;
            for (const l of logs) {
              send('log', toDto(l), l.seq);
              after = l.seq;
            }
            if (dep.status !== lastStatus) {
              lastStatus = dep.status;
              send('status', { status: dep.status, progress: dep.progress, failureReason: dep.failureReason });
            }
            if (isTerminal(dep.status as DeploymentStatus) && logs.length === 0) {
              send('done', { status: dep.status });
              break;
            }
            if (logs.length === 0) controller.enqueue(encoder.encode(': keep-alive\n\n'));
            await new Promise((r) => setTimeout(r, logs.length >= 500 ? 50 : 1000));
          }
        } catch {
          send('error', { message: 'stream interrupted' });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
