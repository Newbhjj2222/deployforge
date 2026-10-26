import type { Prisma, PrismaClient } from '@prisma/client';

export interface AuditInput {
  orgId?: string | null;
  actorId?: string | null;
  action: string; // e.g. "project.create", "env.update", "domain.verify"
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

/** Audit rows never contain secret values; callers pass identifiers and key names only. */
export async function audit(db: Pick<PrismaClient, 'auditLog'>, input: AuditInput) {
  await db.auditLog.create({
    data: {
      orgId: input.orgId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: input.metadata,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    },
  });
}
