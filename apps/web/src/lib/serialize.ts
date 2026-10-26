import 'server-only';
import type { Deployment, Domain, EnvironmentVariable, Project, RepositoryConnection } from '@deployforge/db';
import { MASK, challengeRecordName, challengeRecordValue, dnsInstructions, publicUrl } from '@deployforge/core';
import { config } from './env';

/** Public shapes. Anything not listed here (settings JSON, artifact prefixes, tokens, ciphertext) never leaves the server. */

export function projectDto(p: Project & { connection?: RepositoryConnection | null }) {
  const c = config();
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    framework: p.framework,
    runtime: p.runtime,
    productionBranch: p.productionBranch,
    installCommand: p.installCommand,
    buildCommand: p.buildCommand,
    outputDirectory: p.outputDirectory,
    startCommand: p.startCommand,
    pythonVersion: p.pythonVersion,
    nodeVersion: p.nodeVersion,
    port: p.port,
    healthCheckPath: p.healthCheckPath,
    spaFallback: p.spaFallback,
    previewDeployments: p.previewDeployments,
    activeDeploymentId: p.activeDeploymentId,
    productionUrl: publicUrl(c, `${p.slug}.${c.ROOT_DOMAIN}`),
    repository: p.connection
      ? { fullName: p.connection.fullName, rootDirectory: p.connection.rootDirectory, disabled: Boolean(p.connection.disabledAt) }
      : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function deploymentDto(d: Deployment) {
  const c = config();
  return {
    id: d.id,
    projectId: d.projectId,
    environment: d.environment,
    trigger: d.trigger,
    status: d.status,
    branch: d.branch,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    commitAuthor: d.commitAuthor,
    progress: d.progress,
    attempt: d.attempt,
    failureCode: d.failureCode,
    failureReason: d.failureReason,
    rollbackOfId: d.rollbackOfId,
    runtime: d.runtime,
    runtimeStatus: d.runtimeStatus,
    fileCount: d.fileCount,
    artifactBytes: d.artifactBytes?.toString() ?? null,
    url: d.status === 'READY' ? publicUrl(c, d.previewHostname) : null,
    previewHostname: d.previewHostname,
    startedAt: d.startedAt,
    readyAt: d.readyAt,
    finishedAt: d.finishedAt,
    createdAt: d.createdAt,
  };
}

export function domainDto(d: Domain) {
  const c = config();
  const cname = c.CNAME_TARGET ?? `edge.${c.ROOT_DOMAIN}`;
  const dns = dnsInstructions(d.hostname, d.challengeToken, { cnameTarget: cname, ipv4: c.EDGE_IPV4, ipv6: c.EDGE_IPV6 });
  return {
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    verifiedAt: d.verifiedAt,
    lastCheckedAt: d.lastCheckedAt,
    tlsStatus: d.tlsStatus,
    tlsExpiresAt: d.tlsExpiresAt,
    // The challenge token is not a secret (it must be published in DNS), but it is only shown to project admins.
    dns: d.status === 'PENDING_VERIFICATION' || d.status === 'SUSPENDED' ? dns : { ...dns, txt: { type: 'TXT' as const, name: challengeRecordName(d.hostname), value: challengeRecordValue(d.challengeToken) } },
    createdAt: d.createdAt,
  };
}

/** Env vars are write-only: the value is NEVER returned after creation, only a mask and metadata. */
export function envDto(v: EnvironmentVariable) {
  return { id: v.id, key: v.key, environment: v.environment, scope: v.scope, value: MASK, updatedAt: v.updatedAt, createdAt: v.createdAt };
}
