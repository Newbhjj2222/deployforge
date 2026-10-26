import { NextResponse, type NextRequest } from 'next/server';

/**
 * Edge middleware (no database access):
 *  - CSRF defence in depth for cookie-authenticated JSON APIs: state-changing requests must carry an
 *    Origin (or Referer) that matches the request host. SameSite=Lax cookies are the first layer.
 *    Exempt: the GitHub webhook (HMAC-authenticated) and Auth.js routes (own CSRF token).
 *  - Security headers on every response.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/') && !SAFE.has(req.method) && !pathname.startsWith('/api/webhooks/') && !pathname.startsWith('/api/auth/')) {
    const origin = req.headers.get('origin') ?? req.headers.get('referer');
    let ok = false;
    if (origin) {
      try {
        ok = new URL(origin).host === req.headers.get('host');
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      return NextResponse.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, { status: 403 });
    }
  }
  const res = NextResponse.next();
  res.headers.set('x-content-type-options', 'nosniff');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.headers.set('cross-origin-opener-policy', 'same-origin');
  res.headers.set(
    'content-security-policy',
    // Next.js needs inline styles/scripts for hydration; no third-party origins are allowed.
    "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (process.env.PUBLIC_SCHEME === 'https') res.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
