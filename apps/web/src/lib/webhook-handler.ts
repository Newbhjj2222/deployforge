import { z } from 'zod';
import { AppError, isSha, verifyGitHubSignature, ZERO_SHA } from '@deployforge/core';
import { createDeployment, prisma, Prisma, audit } from '@deployforge/db';

/**
 * GitHub webhook processing, independent of Next.js so it can be unit/integration tested.
 * Order of operations (each step is a security property):
 *   1. verify X-Hub-Signature-256 over the EXACT raw bytes - nothing is parsed before this passes
 *   2. require a delivery id and de-duplicate on it (GitHub retries / manual redelivery)
 *   3. validate the payload shape with Zod
 *   4. match the repository to projects through OUR records (repo id + installation id), not payload names
 *   5. create deployments through the transactional outbox
 */
export interface WebhookEnv {
  secret: string | undefined;
  rootDomain: string;
  maxPerDay: number;
}

export interface WebhookResult {
  status: number;
  body: { ok: boolean; message: string; deployments?: string[] };
}

const MAX_BODY = 2 * 1024 * 1024;

const Repo = z.object({ id: z.number().int(), full_name: z.string().max(300) });
const Inst = z.object({ id: z.number().int() });

const PushPayload = z.object({
  ref: z.string().max(300),
  after: z.string(),
  deleted: z.boolean().optional(),
  repository: Repo,
  installation: Inst.optional(),
  head_commit: z.object({ message: z.string().max(100_000), author: z.object({ name: z.string().max(200) }).partial().optional() }).nullable().optional(),
});
const InstallationPayload = z.object({ action: z.string(), installation: Inst });
const InstallationReposPayload = z.object({
  action: z.string(),
  installation: Inst,
  repositories_removed: z.array(z.object({ id: z.number().int() })).optional(),
});

export async function handleGitHubWebhook(
  rawBody: Uint8Array,
  headers: { get(name: string): string | null },
  env: WebhookEnv,
): Promise<WebhookResult> {
  if (!env.secret) return { status: 503, body: { ok: false, message: 'Webhook secret is not configured (GITHUB_WEBHOOK_SECRET).' } };
  if (rawBody.byteLength > MAX_BODY) return { status: 413, body: { ok: false, message: 'Payload too large' } };
  if (!verifyGitHubSignature(rawBody, headers.get('x-hub-signature-256'), env.secret)) {
    return { status: 401, body: { ok: false, message: 'Invalid signature' } };
  }
  const deliveryId = headers.get('x-github-delivery');
  const event = headers.get('x-github-event');
  if (!deliveryId || !/^[A-Za-z0-9-]{8,64}$/.test(deliveryId) || !event || !/^[a-z_]{1,40}$/.test(event)) {
    return { status: 400, body: { ok: false, message: 'Missing or invalid delivery headers' } };
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  } catch {
    return { status: 400, body: { ok: false, message: 'Malformed JSON' } };
  }
  const { createHash } = await import('node:crypto');
  const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
  const action = typeof (json as { action?: unknown })?.action === 'string' ? String((json as { action: string }).action).slice(0, 40) : null;

  // ── duplicate delivery protection ───────────────────────────────────────────
  try {
    await prisma.webhookDelivery.create({ data: { deliveryId, event, action, payloadSha256 } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const prev = await prisma.webhookDelivery.findUnique({ where: { deliveryId } });
      if (prev && (prev.status === 'PROCESSED' || prev.status === 'IGNORED')) {
        return { status: 200, body: { ok: true, message: 'Duplicate delivery ignored' } };
      }
      // RECEIVED / FAILED: a retry of a delivery we did not finish -> process again (all effects are idempotent)
    } else {
      throw e;
    }
  }

  const finish = async (status: 'PROCESSED' | 'IGNORED' | 'FAILED', detail: string, extra: Partial<{ installationId: bigint; repoId: bigint }> = {}) => {
    await prisma.webhookDelivery.update({ where: { deliveryId }, data: { status, detail: detail.slice(0, 300), processedAt: new Date(), ...extra } });
  };

  try {
    switch (event) {
      case 'ping':
        await finish('PROCESSED', 'pong');
        return { status: 200, body: { ok: true, message: 'pong' } };

      case 'push': {
        const p = PushPayload.safeParse(json);
        if (!p.success) {
          await finish('FAILED', 'invalid push payload');
          return { status: 422, body: { ok: false, message: 'Invalid push payload' } };
        }
        const d = p.data;
        const ids = { repoId: BigInt(d.repository.id), ...(d.installation ? { installationId: BigInt(d.installation.id) } : {}) };
        if (d.deleted || d.after === ZERO_SHA || !isSha(d.after)) {
          await finish('IGNORED', 'branch deletion or invalid sha', ids);
          return { status: 200, body: { ok: true, message: 'Ignored (no commit to deploy)' } };
        }
        const m = /^refs\/heads\/(.+)$/.exec(d.ref);
        if (!m || !d.installation) {
          await finish('IGNORED', 'not a branch push or no installation', ids);
          return { status: 200, body: { ok: true, message: 'Ignored (not a branch push)' } };
        }
        const branch = m[1]!;
        // Verify the repository is actually connected, through the installation we stored for it.
        const connections = await prisma.repositoryConnection.findMany({
          where: { githubRepoId: BigInt(d.repository.id), disabledAt: null, installation: { installationId: BigInt(d.installation.id), status: 'ACTIVE' }, project: { state: 'ACTIVE' } },
          include: { project: true },
        });
        if (connections.length === 0) {
          await finish('IGNORED', 'repository not connected to any project', ids);
          return { status: 200, body: { ok: true, message: 'Ignored (repository not connected)' } };
        }
        const created: string[] = [];
        const message = d.head_commit?.message.split('\n')[0]?.slice(0, 200) ?? null;
        for (const c of connections) {
          const isProd = branch === c.project.productionBranch;
          if (!isProd && !c.project.previewDeployments) continue;
          const { deployment } = await createDeployment({
            projectId: c.projectId,
            environment: isProd ? 'PRODUCTION' : 'PREVIEW',
            trigger: 'WEBHOOK',
            branch,
            commitSha: d.after,
            commitMessage: message,
            commitAuthor: d.head_commit?.author?.name ?? null,
            idempotencyKey: `webhook:${deliveryId}:${c.projectId}`,
            rootDomain: env.rootDomain,
            maxPerDay: env.maxPerDay,
          }).catch(async (err) => {
            if (err instanceof AppError && err.code === 'quota_exceeded') return { deployment: null };
            throw err;
          });
          if (deployment) created.push(deployment.id);
        }
        await finish(created.length ? 'PROCESSED' : 'IGNORED', created.length ? `queued ${created.length} deployment(s)` : 'no matching project settings', ids);
        return { status: 202, body: { ok: true, message: `Queued ${created.length} deployment(s)`, deployments: created } };
      }

      case 'installation': {
        const p = InstallationPayload.safeParse(json);
        if (!p.success) {
          await finish('FAILED', 'invalid installation payload');
          return { status: 422, body: { ok: false, message: 'Invalid payload' } };
        }
        const iid = BigInt(p.data.installation.id);
        const inst = await prisma.gitHubInstallation.findUnique({ where: { installationId: iid } });
        if (inst) {
          const next = p.data.action === 'deleted' ? 'REVOKED' : p.data.action === 'suspend' ? 'SUSPENDED' : p.data.action === 'unsuspend' ? 'ACTIVE' : null;
          if (next) {
            await prisma.$transaction(async (tx) => {
              await tx.gitHubInstallation.update({ where: { id: inst.id }, data: { status: next } });
              // revoked/suspended installations can no longer clone: stop deploying their projects
              await tx.repositoryConnection.updateMany({ where: { installationRef: inst.id }, data: { disabledAt: next === 'ACTIVE' ? null : new Date() } });
              await audit(tx, { orgId: inst.orgId, action: `github.installation.${p.data.action}`, targetType: 'installation', targetId: inst.id });
            });
          }
        }
        await finish('PROCESSED', `installation ${p.data.action}`, { installationId: iid });
        return { status: 200, body: { ok: true, message: `installation ${p.data.action}` } };
      }

      case 'installation_repositories': {
        const p = InstallationReposPayload.safeParse(json);
        if (!p.success) {
          await finish('FAILED', 'invalid payload');
          return { status: 422, body: { ok: false, message: 'Invalid payload' } };
        }
        const removed = (p.data.repositories_removed ?? []).map((r) => BigInt(r.id));
        if (removed.length) {
          await prisma.repositoryConnection.updateMany({
            where: { githubRepoId: { in: removed }, installation: { installationId: BigInt(p.data.installation.id) } },
            data: { disabledAt: new Date() },
          });
        }
        await finish('PROCESSED', `repositories removed: ${removed.length}`, { installationId: BigInt(p.data.installation.id) });
        return { status: 200, body: { ok: true, message: 'ok' } };
      }

      default:
        await finish('IGNORED', `unhandled event ${event}`);
        return { status: 200, body: { ok: true, message: `Ignored event ${event}` } };
    }
  } catch (err) {
    await finish('FAILED', err instanceof Error ? err.message : 'error').catch(() => undefined);
    // 500 makes GitHub show the delivery as failed so it can be redelivered
    return { status: 500, body: { ok: false, message: 'Processing failed; redeliver to retry' } };
  }
}
