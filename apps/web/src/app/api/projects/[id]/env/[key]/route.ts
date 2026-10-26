import { AppError } from '@deployforge/core';
import { audit, encryptEnvValue, prisma, requireProject } from '@deployforge/db';
import { api, parseBody, parseQuery, serialize } from '@/lib/api';
import { config } from '@/lib/env';
import { EnvEnvironment, EnvKey, UpdateEnv } from '@/lib/schemas';
import { envDto } from '@/lib/serialize';
import { z } from 'zod';

type P = { id: string; key: string };

/** Update value and/or scope (also the "rotate secret" operation: new ciphertext, new IV, active key). */
export const PATCH = api<P>(async ({ req, userId, params, ip }) => {
  const { project } = await requireProject(userId, params.id, 'ADMIN');
  const key = EnvKey.parse(params.key);
  const body = await parseBody(req, UpdateEnv);
  const existing = await prisma.environmentVariable.findUnique({ where: { projectId_key_environment: { projectId: project.id, key, environment: body.environment } } });
  if (!existing) throw new AppError('not_found', 'Variable not found');
  const data: { scope?: typeof existing.scope; valueEncrypted?: string; keyId?: number; updatedById: string } = { updatedById: userId };
  if (body.scope) data.scope = body.scope;
  if (body.value !== undefined) {
    const enc = encryptEnvValue(config().keyring, project.id, key, body.environment, body.value);
    data.valueEncrypted = enc.value;
    data.keyId = enc.keyId;
  }
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.environmentVariable.update({ where: { id: existing.id }, data });
    await audit(tx, { orgId: project.orgId, actorId: userId, action: body.value !== undefined ? 'env.rotate' : 'env.update', targetType: 'env', targetId: r.id, metadata: { key, environment: body.environment }, ip });
    return r;
  });
  return serialize({ variable: envDto(row) });
});

export const DELETE = api<P>(async ({ req, userId, params, ip }) => {
  const { project } = await requireProject(userId, params.id, 'ADMIN');
  const key = EnvKey.parse(params.key);
  const { environment } = parseQuery(req, z.object({ environment: EnvEnvironment }));
  const existing = await prisma.environmentVariable.findUnique({ where: { projectId_key_environment: { projectId: project.id, key, environment } } });
  if (!existing) throw new AppError('not_found', 'Variable not found');
  await prisma.$transaction(async (tx) => {
    await tx.environmentVariable.delete({ where: { id: existing.id } });
    await audit(tx, { orgId: project.orgId, actorId: userId, action: 'env.delete', targetType: 'env', targetId: existing.id, metadata: { key, environment }, ip });
  });
  return { ok: true };
});
