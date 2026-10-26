import { NextResponse } from 'next/server';
import { Prisma, hashPassword, prisma, audit } from '@deployforge/db';
import { AppError, slugify } from '@deployforge/core';
import { errorResponse, parseBody } from '@/lib/api';
import { clientIp, rateLimit } from '@/lib/ratelimit';
import { Register } from '@/lib/schemas';

export async function POST(req: Request) {
  try {
    const ip = clientIp(req.headers);
    await rateLimit('register-ip', ip, 5, 3600, { failClosed: true });
    const body = await parseBody(req, Register);
    const passwordHash = await hashPassword(body.password);
    const base = slugify(body.name) || slugify(body.email.split('@')[0]!) || 'user';
    try {
      await prisma.$transaction(async (tx) => {
        const taken = await tx.organization.findUnique({ where: { slug: base } });
        const slug = taken ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base;
        const user = await tx.user.create({ data: { name: body.name, email: body.email, passwordHash } });
        const org = await tx.organization.create({ data: { name: body.name, slug, personal: true, members: { create: { userId: user.id, role: 'OWNER' } } } });
        await audit(tx, { orgId: org.id, actorId: user.id, action: 'user.register', targetType: 'user', targetId: user.id, ip });
      });
    } catch (e) {
      // Same response whether or not the email exists would be ideal; we return 409 because sign-up needs feedback.
      // Account enumeration is mitigated by the per-IP limit above (5/hour).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('conflict', 'An account with this email already exists.');
      throw e;
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
