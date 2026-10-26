import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { z } from 'zod';
import { prisma, equaliseTiming, verifyPassword } from '@deployforge/db';
import { slugify } from '@deployforge/core';
import { rateLimit, clientIp } from './lib/ratelimit';

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}

const LOGIN_MAX_FAILURES = 8;
const LOCK_MINUTES = 15;

const credentialsSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

const providers = [
  Credentials({
    credentials: { email: {}, password: {} },
    async authorize(raw, request) {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();
      const ip = clientIp(request.headers);
      // brute-force protection: per-IP and per-account windows, fail closed
      await rateLimit('login-ip', ip, 30, 600, { failClosed: true });
      await rateLimit('login-acct', email, 10, 600, { failClosed: true });

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.passwordHash) {
        await equaliseTiming(parsed.data.password); // do not reveal whether the account exists
        return null;
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) return null;
      const ok = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!ok) {
        const failures = user.failedLoginCount + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: failures >= LOGIN_MAX_FAILURES
            ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
            : { failedLoginCount: failures },
        });
        return null;
      }
      if (user.failedLoginCount > 0 || user.lockedUntil) {
        await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      }
      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  }),
  ...(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET
    ? [GitHub({ clientId: process.env.AUTH_GITHUB_ID, clientSecret: process.env.AUTH_GITHUB_SECRET, allowDangerousEmailAccountLinking: false })]
    : []),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // Credentials requires JWT sessions. The cookie is HttpOnly, SameSite=Lax and Secure behind HTTPS.
  session: { strategy: 'jwt', maxAge: 14 * 24 * 3600, updateAge: 24 * 3600 },
  providers,
  pages: { signIn: '/login' },
  trustHost: process.env.AUTH_TRUST_HOST === 'true',
  useSecureCookies: process.env.PUBLIC_SCHEME === 'https',
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.uid && session.user) session.user.id = String(token.uid);
      return session;
    },
  },
  events: {
    // GitHub sign-ups get a personal organisation just like password sign-ups
    async createUser({ user }) {
      if (!user.id) return;
      const base = slugify(user.name ?? user.email?.split('@')[0] ?? 'user') || 'user';
      const exists = await prisma.organization.findUnique({ where: { slug: base } });
      const slug = exists ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base;
      await prisma.organization.create({
        data: { name: user.name ?? base, slug, personal: true, members: { create: { userId: user.id, role: 'OWNER' } } },
      });
    },
  },
});
