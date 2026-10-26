import { Redis } from 'ioredis';
import pino from 'pino';
import {
  GitHubClient,
  SandboxClient,
  createStorage,
  loadConfig,
  type ObjectStorage,
  type SharedConfig,
} from '@deployforge/core';

export interface Ctx {
  cfg: SharedConfig;
  log: pino.Logger;
  storage: ObjectStorage;
  sandbox: SandboxClient;
  github: GitHubClient;
  redis: Redis;
  workerId: string;
}

export async function createContext(): Promise<Ctx> {
  const cfg = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'worker' }, redact: ['*.token', '*.password'] });
  const storage = await createStorage({
    driver: cfg.STORAGE_DRIVER,
    localDir: cfg.STORAGE_LOCAL_DIR,
    s3Bucket: cfg.S3_BUCKET,
    s3Region: cfg.S3_REGION,
    s3Endpoint: cfg.S3_ENDPOINT,
    s3AccessKeyId: cfg.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: cfg.S3_FORCE_PATH_STYLE,
    s3KeyPrefix: cfg.S3_KEY_PREFIX,
  });
  if (!cfg.SANDBOX_AGENT_TOKEN) throw new Error('SANDBOX_AGENT_TOKEN is required for the worker');
  const sandbox = new SandboxClient(cfg.SANDBOX_AGENT_URL, cfg.SANDBOX_AGENT_TOKEN);
  const github = new GitHubClient({
    apiUrl: cfg.GITHUB_API_URL,
    appId: cfg.GITHUB_APP_ID,
    privateKey: cfg.GITHUB_APP_PRIVATE_KEY,
    clientId: cfg.GITHUB_CLIENT_ID,
    clientSecret: cfg.GITHUB_CLIENT_SECRET,
  });
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  return { cfg, log, storage, sandbox, github, redis, workerId: `worker-${process.pid}-${Math.random().toString(36).slice(2, 6)}` };
}
