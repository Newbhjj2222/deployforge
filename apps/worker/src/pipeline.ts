import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  AppError,
  buildStaticManifest,
  bundleKey,
  contentTypeFor,
  createRedactor,
  filesKey,
  manifestChecksum,
  manifestKey,
  validateArtifact,
  validateRelativeDir,
  type ManifestFile,
  type StepResult,
} from '@deployforge/core';
import {
  loadAllSecretValues,
  loadEnvForDeployment,
  markReadyAndActivate,
  prisma,
  transitionDeployment,
  type DeploymentSettings,
  type DeploymentStatus,
} from '@deployforge/db';
import type { Ctx } from './context';
import { LogWriter } from './log-writer';

/** A deterministic failure of the user's build (bad command, missing output, limits). Never retried. */
export class BuildFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BuildFailure';
  }
}

/** The deployment was canceled (or already finished) while we worked. Not an error. */
export class Canceled extends Error {}

const IN_PROGRESS: DeploymentStatus[] = ['CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING'];

const TOOLCHAIN = (s: DeploymentSettings) => (s.runtime === 'PYTHON' ? `python-${s.pythonVersion ?? '3.12'}` : `node-${s.nodeVersion}`);

/** pip must install into the bundle-able /workspace/deps directory; the platform adds the flags itself. */
export function pythonInstallCommand(cmd: string): string {
  if (!/^pip3? install\b/.test(cmd)) throw new BuildFailure('unsupported_install', 'Python install commands must start with "pip install".');
  return cmd.replace(/^pip3? install/, 'pip install --no-cache-dir --target /workspace/deps');
}

export function joinDirs(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

export interface BuildOutcome {
  status: 'READY' | 'FAILED' | 'CANCELED' | 'SKIPPED';
}

/**
 * Run one build attempt. Throws only for *infrastructure* problems (sandbox down, storage down);
 * BullMQ retries those with backoff. Deterministic failures mark the deployment FAILED and return.
 */
export async function runBuild(ctx: Ctx, deploymentId: string, attempt: number, isFinalAttempt: boolean): Promise<BuildOutcome> {
  const { cfg, sandbox, storage } = ctx;
  let dep = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
  if (!dep) return { status: 'SKIPPED' };
  if (dep.status === 'READY' || dep.status === 'FAILED' || dep.status === 'CANCELED') return { status: 'SKIPPED' }; // idempotent redelivery
  if (dep.status === 'CANCELING') {
    await transitionDeployment(dep.id, 'CANCELED', { from: ['CANCELING'] });
    return { status: 'CANCELED' };
  }
  if (IN_PROGRESS.includes(dep.status)) {
    // previous attempt died mid-flight (worker crash / retry): start over from QUEUED
    await transitionDeployment(dep.id, 'QUEUED', { from: IN_PROGRESS });
  }
  const claimed = await transitionDeployment(dep.id, 'CLONING', { from: ['QUEUED'] });
  if (!claimed) return { status: 'SKIPPED' }; // canceled or taken by another worker
  await prisma.deployment.update({ where: { id: dep.id }, data: { attempt, failureCode: null, failureReason: null } });
  await prisma.buildJob.upsert({
    where: { deploymentId_attempt: { deploymentId: dep.id, attempt } },
    update: { status: 'RUNNING', startedAt: new Date(), workerId: ctx.workerId, error: null },
    create: { deploymentId: dep.id, attempt, status: 'RUNNING', queueJobId: `outbox_${dep.id}`, workerId: ctx.workerId, startedAt: new Date() },
  });
  dep = await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id }, include: { project: true } });

  const settings = dep.settings as unknown as DeploymentSettings;
  const workspaceId = `${dep.id}-a${attempt}`;
  const prefix = `deployments/${dep.projectId}/${dep.id}/a${attempt}`;
  const hidePaths = ['/workspace', cfg.STORAGE_LOCAL_DIR];

  const buildEnv = await loadEnvForDeployment(cfg.keyring, dep.projectId, dep.environment, 'build');
  const allSecrets = await loadAllSecretValues(cfg.keyring, dep.projectId, dep.environment);
  let githubToken: string | undefined;
  let redactor = createRedactor(allSecrets, { hidePaths });
  const logs = await new LogWriter(dep.id, (l) => redactor(l), cfg.MAX_LOG_LINES_PER_DEPLOYMENT, cfg.MAX_LOG_BYTES_PER_DEPLOYMENT).init();
  let uploaded = false;

  const finishFailed = async (code: string, reason: string) => {
    logs.system(reason, 'ERROR');
    await logs.flush();
    await transitionDeployment(dep.id, 'FAILED', { from: IN_PROGRESS, extra: { failureCode: code, failureReason: redactor(reason).slice(0, 500) } });
    await prisma.buildJob.updateMany({ where: { deploymentId: dep.id, attempt }, data: { status: 'FAILED', finishedAt: new Date(), error: code } });
    // never leave half-published artifacts behind (they would never be referenced)
    if (uploaded) await storage.deletePrefix(prefix).catch(() => undefined);
  };

  const ensureNotCanceled = async () => {
    const cur = await prisma.deployment.findUnique({ where: { id: dep.id }, select: { status: true } });
    if (!cur || cur.status === 'CANCELING' || cur.status === 'CANCELED') throw new Canceled();
  };

  /** Run one sandbox step, streaming redacted logs and polling for cancellation. */
  const step = async (kind: 'clone' | 'install' | 'build', req: Partial<Parameters<typeof sandbox.runStep>[0]> & { command?: string }): Promise<StepResult> => {
    const stepId = `${dep.id}-a${attempt}-${kind}`;
    const abort = new AbortController();
    const poll = setInterval(async () => {
      const cur = await prisma.deployment.findUnique({ where: { id: dep.id }, select: { status: true } }).catch(() => null);
      if (cur && (cur.status === 'CANCELING' || cur.status === 'CANCELED')) {
        await sandbox.cancelStep(stepId);
        abort.abort();
      }
    }, 3000);
    try {
      return await sandbox.runStep(
        {
          step_id: stepId,
          kind,
          workspace_id: workspaceId,
          toolchain: 'git',
          timeout_seconds: 600,
          network: 'none',
          memory_mb: cfg.BUILD_MEMORY_MB,
          cpus: cfg.BUILD_CPUS,
          pids: cfg.BUILD_PIDS_LIMIT,
          ...req,
        } as Parameters<typeof sandbox.runStep>[0],
        (e) => logs.add(e.line, e.stream === 'stderr' ? 'WARN' : 'INFO', e.stream === 'stderr' ? 'STDERR' : e.stream === 'stdout' ? 'STDOUT' : 'SYSTEM'),
        abort.signal,
      );
    } catch (err) {
      if (abort.signal.aborted) throw new Canceled();
      throw err;
    } finally {
      clearInterval(poll);
    }
  };

  const checkResult = async (name: string, r: StepResult) => {
    await ensureNotCanceled();
    if (r.timed_out) throw new BuildFailure('timeout', `${name} timed out`);
    if (r.oom_killed) throw new BuildFailure('out_of_memory', `${name} ran out of memory (limit ${cfg.BUILD_MEMORY_MB} MB)`);
    if (r.exit_code !== 0) throw new BuildFailure('command_failed', `${name} failed with exit code ${r.exit_code}`);
  };

  try {
    logs.system(`Build attempt ${attempt} started on ${ctx.workerId}`);
    logs.system(`Commit ${dep.commitSha.slice(0, 7)} on ${dep.branch}`);

    // ── CLONING ───────────────────────────────────────────────────────────────
    if (!settings.repo) throw new BuildFailure('no_repository', 'Project has no connected repository.');
    const conn = await prisma.repositoryConnection.findUnique({ where: { projectId: dep.projectId }, include: { installation: true } });
    if (!conn || conn.disabledAt || conn.installation.status !== 'ACTIVE') {
      throw new BuildFailure('repository_unavailable', 'The GitHub installation for this project is no longer active.');
    }
    let source: NonNullable<Parameters<typeof sandbox.runStep>[0]['source']>;
    if (cfg.DEV_LOCAL_GIT_ROOT && conn.fullName.startsWith('local/')) {
      source = { kind: 'local', path: path.join(cfg.DEV_LOCAL_GIT_ROOT, conn.fullName.slice('local/'.length)), sha: dep.commitSha };
      logs.system('Using local development repository');
    } else {
      githubToken = await ctx.github.installationToken(Number(conn.installation.installationId), { repositoryIds: [Number(conn.githubRepoId)] });
      redactor = createRedactor([...allSecrets, githubToken], { hidePaths });
      source = { kind: 'https', url: ctx.github.cloneUrl(conn.fullName), sha: dep.commitSha, token: githubToken };
    }
    const cloneRes = await step('clone', { toolchain: 'git', network: 'egress', timeout_seconds: cfg.CLONE_TIMEOUT_SECONDS, source, env: {} });
    await checkResult('Clone', cloneRes);

    const rootDir = validateRelativeDir(settings.rootDirectory ?? '');
    const workdir = joinDirs('src', rootDir);
    const toolchain = TOOLCHAIN(settings);
    const isPython = settings.runtime === 'PYTHON';

    // ── INSTALLING ────────────────────────────────────────────────────────────
    if (settings.installCommand) {
      if (!(await transitionDeployment(dep.id, 'INSTALLING', { from: ['CLONING'] }))) throw new Canceled();
      logs.system(`$ ${settings.installCommand}`);
      const cmd = isPython ? pythonInstallCommand(settings.installCommand) : settings.installCommand;
      const r = await step('install', { toolchain, command: cmd, workdir, env: buildEnv, network: 'egress', timeout_seconds: cfg.INSTALL_TIMEOUT_SECONDS });
      await checkResult('Install', r);
    }

    // ── BUILDING ──────────────────────────────────────────────────────────────
    const from: DeploymentStatus[] = settings.installCommand ? ['INSTALLING'] : ['CLONING'];
    if (!(await transitionDeployment(dep.id, 'BUILDING', { from }))) throw new Canceled();
    if (settings.buildCommand) {
      logs.system(`$ ${settings.buildCommand}`);
      // build commands run WITHOUT network: dependencies were fetched in the install step
      const r = await step('build', { toolchain, command: settings.buildCommand, workdir, env: buildEnv, network: 'none', timeout_seconds: cfg.BUILD_TIMEOUT_SECONDS });
      await checkResult('Build', r);
    } else {
      logs.system('No build command configured; skipping build step.');
    }

    // ── UPLOADING ─────────────────────────────────────────────────────────────
    if (!(await transitionDeployment(dep.id, 'UPLOADING', { from: ['BUILDING'] }))) throw new Canceled();
    let totalBytes = 0;
    let fileCount = 0;
    let checksum: string;
    if (isPython) {
      logs.system('Packaging application bundle');
      const stream = await sandbox.pack(workspaceId, rootDir, { maxBytes: cfg.MAX_ARTIFACT_BYTES });
      const buf = await streamToBuffer(stream, cfg.MAX_ARTIFACT_BYTES);
      const sha = createHash('sha256').update(buf).digest('hex');
      const key = bundleKey(prefix);
      uploaded = true;
      await storage.put(key, buf, { contentType: 'application/gzip', sha256: sha });
      const manifest = { ...buildStaticManifest([], false), kind: 'python' as const, bundle: { key, size: buf.length, sha256: sha } };
      checksum = manifestChecksum(manifest);
      await storage.put(manifestKey(prefix), Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });
      totalBytes = buf.length;
      fileCount = 1;
    } else {
      const outDir = validateRelativeDir(settings.outputDirectory ?? '');
      const tree = await sandbox
        .tree(workspaceId, joinDirs(rootDir, outDir), { maxFiles: cfg.MAX_ARTIFACT_FILES, maxBytes: cfg.MAX_ARTIFACT_BYTES, maxFileBytes: cfg.MAX_ARTIFACT_FILE_BYTES })
        .catch((e) => {
          if (e instanceof AppError && (e.code === 'not_found' || e.code === 'payload_too_large')) {
            throw new BuildFailure(e.code === 'not_found' ? 'output_missing' : 'output_too_large', e.code === 'not_found' ? `Output directory "${outDir || '.'}" was not produced by the build.` : e.message);
          }
          throw e;
        });
      if (tree.skipped.length) logs.system(`Skipped ${tree.skipped.length} hidden/symlinked/ignored entries`, 'DEBUG');
      if (!tree.files.some((f) => f.path === 'index.html')) {
        throw new BuildFailure('no_index', `Build output "${outDir || '.'}" has no index.html at its root.`);
      }
      logs.system(`Uploading ${tree.files.length} files (${(tree.total_size / 1024).toFixed(1)} KiB)`);
      uploaded = true;
      const entries: ManifestFile[] = [];
      for (const f of tree.files) {
        await ensureNotCanceled();
        const body = await sandbox.readFile(workspaceId, joinDirs('', rootDir, outDir, f.path).replace(/^\//, ''));
        const buf = await streamToBuffer(body, cfg.MAX_ARTIFACT_FILE_BYTES);
        const sha = createHash('sha256').update(buf).digest('hex');
        if (sha !== f.sha256 || buf.length !== f.size) throw new BuildFailure('output_changed', `File changed while uploading: ${f.path}`);
        const ct = contentTypeFor(f.path);
        await storage.put(filesKey(prefix, f.path), buf, { contentType: ct, sha256: sha });
        entries.push({ path: f.path, size: f.size, sha256: sha, contentType: ct });
      }
      const manifest = buildStaticManifest(entries, settings.spaFallback);
      checksum = manifestChecksum(manifest);
      await storage.put(manifestKey(prefix), Buffer.from(JSON.stringify(manifest)), { contentType: 'application/json' });
      totalBytes = manifest.totalSize;
      fileCount = entries.length;
    }
    await prisma.deployment.update({
      where: { id: dep.id },
      data: { artifactPrefix: prefix, artifactChecksum: checksum, artifactBytes: BigInt(totalBytes), fileCount },
    });

    // ── DEPLOYING ─────────────────────────────────────────────────────────────
    if (!(await transitionDeployment(dep.id, 'DEPLOYING', { from: ['UPLOADING'] }))) throw new Canceled();
    logs.system('Validating artifacts');
    await validateArtifact(storage, prefix, checksum).catch((e) => {
      throw new BuildFailure('artifact_invalid', `Artifact validation failed: ${(e as Error).message}`);
    });
    if (isPython) {
      const envRuntime = await loadEnvForDeployment(cfg.keyring, dep.projectId, dep.environment, 'runtime');
      await startPythonRuntime(ctx, dep.id, prefix, settings, envRuntime, logs);
    }
    await ensureNotCanceled();
    const done = await markReadyAndActivate(dep.id);
    if (!done.ok) throw new Canceled();
    logs.system(done.activated ? 'Deployment is live (promoted to production)' : 'Deployment is ready');
    await logs.flush();
    await prisma.buildJob.updateMany({ where: { deploymentId: dep.id, attempt }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
    await prisma.usageRecord.upsert({
      where: { deploymentId_metric: { deploymentId: dep.id, metric: 'BUILD_SECONDS' } },
      update: {},
      create: { orgId: dep.project.orgId, projectId: dep.projectId, deploymentId: dep.id, metric: 'BUILD_SECONDS', quantity: BigInt(Math.max(1, Math.round((Date.now() - (dep.startedAt ?? new Date()).getTime()) / 1000))) },
    });
    return { status: 'READY' };
  } catch (err) {
    if (err instanceof Canceled) {
      logs.system('Deployment canceled', 'WARN');
      await logs.flush();
      await transitionDeployment(dep.id, 'CANCELED', { from: ['CANCELING'] });
      await prisma.buildJob.updateMany({ where: { deploymentId: dep.id, attempt }, data: { status: 'CANCELED', finishedAt: new Date() } });
      if (uploaded) await storage.deletePrefix(prefix).catch(() => undefined);
      return { status: 'CANCELED' };
    }
    if (err instanceof BuildFailure) {
      await finishFailed(err.code, err.message);
      return { status: 'FAILED' };
    }
    // infrastructure error: retry (if attempts remain) or give up
    const msg = (err as Error).message ?? String(err);
    ctx.log.error({ err, deploymentId: dep.id, attempt }, 'build infrastructure error');
    if (!isFinalAttempt) {
      logs.system(`Infrastructure error, will retry: ${msg}`, 'WARN');
      await logs.flush();
      await transitionDeployment(dep.id, 'QUEUED', { from: IN_PROGRESS });
      await prisma.buildJob.updateMany({ where: { deploymentId: dep.id, attempt }, data: { status: 'FAILED', finishedAt: new Date(), error: msg.slice(0, 300) } });
      if (uploaded) await storage.deletePrefix(prefix).catch(() => undefined);
    } else {
      await finishFailed('infrastructure_error', 'The platform could not complete this build. Please try again.');
      await prisma.buildJob.updateMany({ where: { deploymentId: dep.id, attempt }, data: { status: 'DEAD', error: msg.slice(0, 300) } });
    }
    throw err;
  } finally {
    await logs.flush();
    await sandbox.deleteWorkspace(workspaceId);
  }
}

export async function startPythonRuntime(
  ctx: Ctx,
  deploymentId: string,
  prefix: string,
  settings: DeploymentSettings,
  env: Record<string, string>,
  logs?: LogWriter,
): Promise<void> {
  const { storage, sandbox, cfg } = ctx;
  if (!settings.startCommand) throw new BuildFailure('no_start_command', 'A start command is required for Python applications.');
  logs?.system('Uploading bundle to the runtime host');
  const { body } = await storage.get(bundleKey(prefix));
  await sandbox.putBundle(deploymentId, body, cfg.MAX_ARTIFACT_BYTES);
  logs?.system(`Starting application (port ${settings.port}, health check ${settings.healthCheckPath})`);
  await prisma.deployment.update({ where: { id: deploymentId }, data: { runtimeStatus: 'STARTING' } });
  const info = await sandbox.startRuntime({
    deployment_id: deploymentId,
    toolchain: `python-${settings.pythonVersion ?? '3.12'}`,
    command: settings.startCommand,
    port: settings.port,
    health_path: settings.healthCheckPath,
    env,
    memory_mb: cfg.RUNTIME_MEMORY_MB,
    cpus: cfg.RUNTIME_CPUS,
    startup_timeout_seconds: 60,
  });
  if (!info.healthy) {
    const tail = await sandbox.runtimeLogs(deploymentId, 40).catch(() => []);
    for (const l of tail) logs?.add(l, 'WARN', 'STDERR');
    await sandbox.stopRuntime(deploymentId).catch(() => undefined);
    await prisma.deployment.update({ where: { id: deploymentId }, data: { runtimeStatus: 'FAILED' } });
    throw new BuildFailure('health_check_failed', `The application did not become healthy on ${settings.healthCheckPath} within 60 seconds.`);
  }
  await prisma.deployment.update({ where: { id: deploymentId }, data: { runtimeStatus: 'RUNNING' } });
  logs?.system('Application is healthy');
}

async function streamToBuffer(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += b.length;
    if (size > max) throw new BuildFailure('output_too_large', 'Build output exceeds the configured limits');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
