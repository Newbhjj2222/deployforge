import 'server-only';
import { AppError } from '@deployforge/core';
import { audit, prisma } from '@deployforge/db';
import { config, github, isDevLocalGit } from './env';
import { LOCAL_INSTALLATION_ID } from './git-provider';

/** The organisation a new installation is attached to: the user's personal org (they must be ADMIN+). */
async function targetOrg(userId: string, orgId?: string) {
  const m = await prisma.organizationMember.findFirst({
    where: { userId, role: { in: ['OWNER', 'ADMIN'] }, ...(orgId ? { orgId } : { org: { personal: true } }) },
    select: { orgId: true },
  });
  if (!m) throw new AppError('forbidden', 'You need admin access to an organization to connect GitHub.');
  return m.orgId;
}

export async function connectLocalInstallation(userId: string, orgId?: string) {
  if (!isDevLocalGit()) throw new AppError('not_configured', 'Local development repositories are not enabled (set DEV_LOCAL_GIT_ROOT; not available in production).');
  const org = await targetOrg(userId, orgId);
  const existing = await prisma.gitHubInstallation.findUnique({ where: { installationId: LOCAL_INSTALLATION_ID } });
  if (existing && existing.orgId !== org) throw new AppError('conflict', 'The local installation belongs to another organization.');
  return (
    existing ??
    prisma.gitHubInstallation.create({
      data: { installationId: LOCAL_INSTALLATION_ID, orgId: org, accountLogin: 'local', accountId: 0n, accountType: 'Local', connectedById: userId },
    })
  );
}

/**
 * Attach a real GitHub App installation. `code` is the OAuth code GitHub appends to the Setup URL when the
 * App requests user authorization during installation; we exchange it and confirm the signed-in user can
 * really see this installation. Without that proof, anyone could claim another account's installation id.
 */
export async function connectGitHubInstallation(userId: string, installationId: number, code: string | null, orgId?: string) {
  const c = config();
  if (!c.GITHUB_APP_ID || !c.GITHUB_APP_PRIVATE_KEY) {
    throw new AppError('not_configured', 'GitHub App is not configured on this server. See docs/github-app.md.');
  }
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new AppError('bad_request', 'Invalid installation id');
  if (!code) throw new AppError('forbidden', 'GitHub did not provide an authorization code. Enable "Request user authorization (OAuth) during installation" on the GitHub App.');
  const gh = github();
  if (!(await gh.userCanAccessInstallation(code, installationId))) throw new AppError('forbidden', 'Your GitHub account cannot access this installation.');
  const info = await gh.getInstallation(installationId);
  if (!info.account) throw new AppError('upstream_error', 'GitHub returned an installation without an account.');
  const org = await targetOrg(userId, orgId);
  const existing = await prisma.gitHubInstallation.findUnique({ where: { installationId: BigInt(installationId) } });
  if (existing && existing.orgId !== org) throw new AppError('conflict', 'This installation is already connected to another organization.');
  return prisma.$transaction(async (tx) => {
    const row = await tx.gitHubInstallation.upsert({
      where: { installationId: BigInt(installationId) },
      update: { status: info.suspended_at ? 'SUSPENDED' : 'ACTIVE', accountLogin: info.account!.login },
      create: { installationId: BigInt(installationId), orgId: org, accountLogin: info.account!.login, accountId: BigInt(info.account!.id), accountType: info.account!.type, connectedById: userId, status: info.suspended_at ? 'SUSPENDED' : 'ACTIVE' },
    });
    await audit(tx, { orgId: org, actorId: userId, action: 'github.connect', targetType: 'installation', targetId: row.id, metadata: { login: row.accountLogin } });
    return row;
  });
}
