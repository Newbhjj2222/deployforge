import type { DeploymentEnvironment, EnvScope } from '@prisma/client';
import { decrypt, encrypt, type Keyring } from '@deployforge/core';
import { prisma } from './client';

/** AAD binds each ciphertext to its own row identity, so values cannot be swapped between rows. */
export const envAad = (projectId: string, key: string, environment: DeploymentEnvironment) =>
  `${projectId}:${key}:${environment}`;

export function encryptEnvValue(ring: Keyring, projectId: string, key: string, environment: DeploymentEnvironment, value: string) {
  return encrypt(value, ring, envAad(projectId, key, environment));
}

/**
 * Resolve plaintext variables for a deployment. ONLY the worker calls this, and only with the scope
 * it needs: build steps get BUILD / BUILD_AND_RUNTIME, runtime containers get RUNTIME / BUILD_AND_RUNTIME.
 */
export async function loadEnvForDeployment(
  ring: Keyring,
  projectId: string,
  environment: DeploymentEnvironment,
  phase: 'build' | 'runtime',
): Promise<Record<string, string>> {
  const scopes: EnvScope[] = phase === 'build' ? ['BUILD', 'BUILD_AND_RUNTIME'] : ['RUNTIME', 'BUILD_AND_RUNTIME'];
  const rows = await prisma.environmentVariable.findMany({ where: { projectId, environment, scope: { in: scopes } } });
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = decrypt(r.valueEncrypted, ring, envAad(projectId, r.key, environment));
  return out;
}

/** Every secret value the project has, for log redaction (regardless of scope). */
export async function loadAllSecretValues(ring: Keyring, projectId: string, environment: DeploymentEnvironment): Promise<string[]> {
  const rows = await prisma.environmentVariable.findMany({ where: { projectId, environment } });
  return rows.map((r) => decrypt(r.valueEncrypted, ring, envAad(projectId, r.key, environment)));
}

/** Env var names that would let a repository subvert the sandbox or the platform; rejected at the API. */
export const RESERVED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'PWD', 'PORT', 'HOSTNAME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'DOCKER_HOST', 'DEPLOYFORGE', 'CI',
]);
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const isReservedEnvKey = (k: string) =>
  RESERVED_ENV_KEYS.has(k.toUpperCase()) || /^(LD_|DYLD_|DOCKER_|DEPLOYFORGE_|AWS_|GITHUB_|INTERNAL_|SANDBOX_)/.test(k.toUpperCase());
