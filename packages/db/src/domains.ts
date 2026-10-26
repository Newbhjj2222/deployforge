import { Prisma } from '@prisma/client';
import {
  AppError,
  DOMAIN_RECHECK_GRACE_FAILURES,
  challengeRecordName,
  newChallengeToken,
  txtMatchesChallenge,
  validateCustomDomain,
} from '@deployforge/core';
import { prisma } from './client';
import { audit } from './audit';

export type TxtResolver = (name: string) => Promise<string[][]>;

export async function addDomain(opts: { projectId: string; orgId: string; actorId: string; hostname: string; rootDomain: string; maxPerProject: number }) {
  const check = validateCustomDomain(opts.hostname, opts.rootDomain);
  if (!check.ok) throw new AppError('validation_failed', check.reason);
  const count = await prisma.domain.count({ where: { projectId: opts.projectId } });
  if (count >= opts.maxPerProject) throw new AppError('quota_exceeded', `Domain limit reached (${opts.maxPerProject} per project).`);
  try {
    const domain = await prisma.$transaction(async (tx) => {
      const d = await tx.domain.create({
        data: { projectId: opts.projectId, hostname: check.hostname, challengeToken: newChallengeToken() },
      });
      await audit(tx, { orgId: opts.orgId, actorId: opts.actorId, action: 'domain.add', targetType: 'domain', targetId: d.id, metadata: { hostname: d.hostname } });
      return d;
    });
    return domain;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError('conflict', 'This domain is already added to the project.');
    }
    throw e;
  }
}

export type VerifyOutcome = { status: 'ACTIVE' | 'PENDING_VERIFICATION' | 'SUSPENDED'; verified: boolean; message: string };

/**
 * Verify ownership by looking for the TXT challenge. Activation is the ONLY place a hostname becomes
 * routable, and it is guarded by the unique index on Domain.activeHostname (first verified owner wins;
 * a second project proving the same name gets a conflict until the first releases it).
 */
export async function verifyDomain(domainId: string, resolveTxt: TxtResolver, actorId?: string | null): Promise<VerifyOutcome> {
  const d = await prisma.domain.findUnique({ where: { id: domainId }, include: { project: true } });
  if (!d || d.project.state !== 'ACTIVE') throw new AppError('not_found', 'Domain not found');

  let records: string[][] = [];
  let lookupFailed = false;
  try {
    records = await resolveTxt(challengeRecordName(d.hostname));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOTFOUND' && code !== 'ENODATA') lookupFailed = true; // SERVFAIL / timeout: inconclusive
  }
  const now = new Date();
  const matches = txtMatchesChallenge(records, d.challengeToken);

  if (lookupFailed) {
    await prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now } });
    return { status: d.status, verified: d.status === 'ACTIVE', message: 'DNS lookup failed; try again shortly.' };
  }

  if (matches) {
    if (d.status === 'ACTIVE') {
      await prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now, verificationFailures: 0 } });
      return { status: 'ACTIVE', verified: true, message: 'Domain is verified.' };
    }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.domain.update({
          where: { id: d.id },
          data: { status: 'ACTIVE', activeHostname: d.hostname, verifiedAt: now, lastCheckedAt: now, verificationFailures: 0, tlsStatus: 'PENDING' },
        });
        await audit(tx, { orgId: d.project.orgId, actorId, action: 'domain.verify', targetType: 'domain', targetId: d.id, metadata: { hostname: d.hostname } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppError('conflict', 'This domain is already verified by another project. Remove it there first.');
      }
      throw e;
    }
    return { status: 'ACTIVE', verified: true, message: 'Domain verified. A TLS certificate will be issued on first request.' };
  }

  if (d.status === 'ACTIVE') {
    const failures = d.verificationFailures + 1;
    if (failures >= DOMAIN_RECHECK_GRACE_FAILURES) {
      // challenge record is gone for days: release the name (protects against dangling-record takeover)
      await prisma.$transaction(async (tx) => {
        await tx.domain.update({ where: { id: d.id }, data: { status: 'SUSPENDED', lastCheckedAt: now, verificationFailures: failures, tlsStatus: 'UNKNOWN' } /* activeHostname stays set: SUSPENDED still reserves the name */ });
        await audit(tx, { orgId: d.project.orgId, action: 'domain.suspend', targetType: 'domain', targetId: d.id });
      });
      return { status: 'SUSPENDED', verified: false, message: 'Verification record removed; domain suspended.' };
    }
    await prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now, verificationFailures: failures } });
    return { status: 'ACTIVE', verified: true, message: 'Verification record missing; will retry before suspending.' };
  }
  await prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now, verificationFailures: { increment: 1 } } });
  return { status: d.status, verified: false, message: 'TXT record not found yet. DNS changes can take a while to propagate.' };
}

