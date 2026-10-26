import { audit, prisma, requireDomain } from '@deployforge/db';
import { api } from '@/lib/api';

/** Removing a domain deletes the row, which releases the activeHostname unique lock immediately. */
export const DELETE = api<{ id: string }>(async ({ userId, params, ip }) => {
  const { domain, project } = await requireDomain(userId, params.id, 'ADMIN');
  await prisma.$transaction(async (tx) => {
    await tx.domain.delete({ where: { id: domain.id } });
    await audit(tx, { orgId: project.orgId, actorId: userId, action: 'domain.remove', targetType: 'domain', targetId: domain.id, metadata: { hostname: domain.hostname }, ip });
  });
  return { ok: true };
});
