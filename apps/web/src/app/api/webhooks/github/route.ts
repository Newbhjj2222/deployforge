import { NextResponse } from 'next/server';
import { handleGitHubWebhook } from '@/lib/webhook-handler';
import { config } from '@/lib/env';
import { clientIp, rateLimit } from '@/lib/ratelimit';
import { errorResponse } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** NOT session-authenticated (GitHub calls it); authenticity comes from the HMAC signature. */
export async function POST(req: Request) {
  try {
    await rateLimit('webhook-ip', clientIp(req.headers), 600, 60);
    const c = config();
    // read the body as bytes exactly once: the signature is computed over these bytes
    const raw = new Uint8Array(await req.arrayBuffer());
    const r = await handleGitHubWebhook(raw, req.headers, { secret: c.GITHUB_WEBHOOK_SECRET, rootDomain: c.ROOT_DOMAIN, maxPerDay: c.LIMIT_DEPLOYMENTS_PER_PROJECT_PER_DAY });
    return NextResponse.json(r.body, { status: r.status });
  } catch (err) {
    return errorResponse(err);
  }
}
