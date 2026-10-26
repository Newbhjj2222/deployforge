import { z } from 'zod';
import { parseKeyring, type Keyring } from './crypto';

/**
 * Environment configuration. Each service validates only what it needs through a purpose-built
 * loader, so a missing GitHub key never stops the worker from booting but produces a precise
 * `not_configured` error where GitHub is actually required.
 */

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? '').toLowerCase() === 'true' || v === '1');

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

const BaseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PLATFORM_NAME: z.string().min(1).max(40).default('DeployForge'),
  ROOT_DOMAIN: z.string().min(3).default('localhost'),
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('http'),
  PUBLIC_PORT_SUFFIX: z.string().default(''), // e.g. ":8080" in local dev
  APP_HOST: z.string().min(1).default('app.localhost'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  ENCRYPTION_KEYS: z.string().min(1),
  ENCRYPTION_KEY_ACTIVE: int(1),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.data/artifacts'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  S3_KEY_PREFIX: z.string().optional(),
  INTERNAL_TOKEN: z.string().min(16).optional(),
  SANDBOX_AGENT_URL: z.string().default('http://localhost:8700'),
  SANDBOX_AGENT_TOKEN: z.string().min(16).optional(),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(), // PEM, or base64 of PEM
  GITHUB_WEBHOOK_SECRET: z.string().min(8).optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  DEV_LOCAL_GIT_ROOT: z.string().optional(), // dev/test only: serve repositories from a local directory
  // Limits (all overridable)
  LIMIT_PROJECTS_PER_ORG: int(10),
  LIMIT_DEPLOYMENTS_PER_PROJECT_PER_DAY: int(50),
  LIMIT_ENV_VARS_PER_PROJECT: int(100),
  LIMIT_DOMAINS_PER_PROJECT: int(10),
  BUILD_TIMEOUT_SECONDS: int(900),
  INSTALL_TIMEOUT_SECONDS: int(900),
  CLONE_TIMEOUT_SECONDS: int(180),
  BUILD_MEMORY_MB: int(2048),
  BUILD_CPUS: z.string().optional().transform((v) => (v ? Number(v) : 2)),
  BUILD_PIDS_LIMIT: int(512),
  MAX_ARTIFACT_FILES: int(10_000),
  MAX_ARTIFACT_BYTES: int(500 * 1024 * 1024),
  MAX_ARTIFACT_FILE_BYTES: int(50 * 1024 * 1024),
  MAX_LOG_LINES_PER_DEPLOYMENT: int(20_000),
  MAX_LOG_BYTES_PER_DEPLOYMENT: int(5 * 1024 * 1024),
  LOG_RETENTION_DAYS: int(30),
  RUNTIME_MEMORY_MB: int(512),
  RUNTIME_CPUS: z.string().optional().transform((v) => (v ? Number(v) : 0.5)),
  EDGE_INTERNAL_URL: z.string().default('http://localhost:8080'),
  EDGE_TLS_PROBE_ADDR: z.string().optional(), // host:port of the public TLS listener, prod only
  CNAME_TARGET: z.string().optional(),
  EDGE_IPV4: z.string().optional(),
  EDGE_IPV6: z.string().optional(),
});

export type SharedConfig = z.infer<typeof BaseSchema> & { keyring: Keyring };

export function loadConfig(env: Record<string, string | undefined> = process.env): SharedConfig {
  const parsed = BaseSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.STORAGE_DRIVER === 'local') {
      throw new Error('STORAGE_DRIVER=local is development-only; use s3 in production');
    }
    if (cfg.DEV_LOCAL_GIT_ROOT) throw new Error('DEV_LOCAL_GIT_ROOT must not be set in production');
    if (!cfg.INTERNAL_TOKEN || !cfg.SANDBOX_AGENT_TOKEN) {
      throw new Error('INTERNAL_TOKEN and SANDBOX_AGENT_TOKEN are required in production');
    }
  }
  const keyring = parseKeyring(cfg.ENCRYPTION_KEYS, cfg.ENCRYPTION_KEY_ACTIVE);
  return { ...cfg, keyring };
}

export const publicUrl = (cfg: Pick<SharedConfig, 'PUBLIC_SCHEME' | 'PUBLIC_PORT_SUFFIX'>, host: string) =>
  `${cfg.PUBLIC_SCHEME}://${host}${cfg.PUBLIC_PORT_SUFFIX}`;

export const branding = (cfg: Pick<SharedConfig, 'PLATFORM_NAME'>) => ({ name: cfg.PLATFORM_NAME });
