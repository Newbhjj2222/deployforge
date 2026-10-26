import { AppError } from '@deployforge/core';
import { ENV_KEY_RE, Prisma, audit, encryptEnvValue, isReservedEnvKey, prisma, requireProject } from '@deployforge/db';
import { api, parseBody, serialize } from '@/lib/api';
import { config } from '@/lib/env';
import { CreateEnv } from '@/lib/schemas';
import { envDto } from '@/lib/serialize';

type P = { id: string };

/** Lists variable NAMES and metadata. Values are write-only and are never returned. */
export const GET = api<P>(async ({ userId, params }) => {
  await requireProject(userId, params.id, 'MEMBER');
  const vars = await prisma.environmentVariable.findMany({ where: { projectId: params.id }, orderBy: [{ key: 'asc' }, { environment: 'asc' }] });
  return serialize({ variables: vars.map(envDto) });
});

export const POST = api<P>(async ({ req, userId, params, ip }) => {
  const { project } = await requireProject(userId, params.id, 'ADMIN');
  const body = await parseBody(req, CreateEnv);
  const cfg = config();
  if (!ENV_KEY_RE.test(body.key) || isReservedEnvKey(body.key)) throw new AppError('validation_failed', `"${body.key}" is reserved and cannot be used.`);
  if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)/.test(body.key) && body.scope !== 'BUILD' && body.scope !== 'BUILD_AND_RUNTIME') {
    throw new AppError('validation_failed', 'Public-prefixed variables are inlined into client bundles at build time.');
  }
  const count = await prisma.environmentVariable.count({ where: { projectId: project.id } });
  if (count >= cfg.LIMIT_ENV_VARS_PER_PROJECT) throw new AppError('quota_exceeded', `Variable limit reached (${cfg.LIMIT_ENV_VARS_PER_PROJECT}).`);
  const enc = encryptEnvValue(cfg.keyring, project.id, body.key, body.environment, body.value);
  try {
    const v = await prisma.$transaction(async (tx) => {
      const row = await tx.environmentVariable.create({
        data: { projectId: project.id, key: body.key, environment: body.environment, scope: body.scope, valueEncrypted: enc.value, keyId: enc.keyId, updatedById: userId },
      });
      // audit stores the NAME only, never the value
      await audit(tx, { orgId: project.orgId, actorId: userId, action: 'env.create', targetType: 'env', targetId: row.id, metadata: { key: body.key, environment: body.environment, scope: body.scope }, ip });
      return row;
    });
    return serialize({ variable: envDto(v) });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('conflict', 'This variable already exists for that environment. Edit it instead.');
    throw e;
  }
});
