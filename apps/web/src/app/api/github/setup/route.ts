import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { config } from '@/lib/env';
import { connectGitHubInstallation } from '@/lib/github-install';

/**
 * GitHub "Setup URL" redirect target (browser navigation, so it redirects instead of returning JSON).
 * Configure the GitHub App's Setup URL as  https://<APP_HOST>/api/github/setup  and tick
 * "Request user authorization (OAuth) during installation".
 */
export async function GET(req: NextRequest) {
  const c = config();
  const base = `${c.PUBLIC_SCHEME}://${c.APP_HOST}${c.PUBLIC_PORT_SUFFIX}`;
  const session = await auth();
  const q = req.nextUrl.searchParams;
  if (!session?.user?.id) {
    return NextResponse.redirect(`${base}/login?callbackUrl=${encodeURIComponent(`/api/github/setup?${q.toString()}`)}`);
  }
  try {
    const id = Number(q.get('installation_id'));
    await connectGitHubInstallation(session.user.id, id, q.get('code'));
    return NextResponse.redirect(`${base}/github?connected=1`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to connect GitHub';
    return NextResponse.redirect(`${base}/github?error=${encodeURIComponent(msg.slice(0, 200))}`);
  }
}
