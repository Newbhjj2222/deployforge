import { LocalStorage } from './local';
import type { ObjectStorage } from './types';

export * from './types';
export * from './manifest';
export * from './mime';
export { LocalStorage } from './local';

export interface StorageConfig {
  driver: 'local' | 's3';
  localDir: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle?: boolean;
  s3KeyPrefix?: string;
}

export async function createStorage(cfg: StorageConfig): Promise<ObjectStorage> {
  if (cfg.driver === 'local') return new LocalStorage(cfg.localDir);
  if (!cfg.s3Bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  // dynamic import keeps the AWS SDK out of processes that only use local storage
  const { S3Storage } = await import('./s3');
  return new S3Storage({
    bucket: cfg.s3Bucket,
    region: cfg.s3Region ?? 'us-east-1',
    endpoint: cfg.s3Endpoint,
    accessKeyId: cfg.s3AccessKeyId,
    secretAccessKey: cfg.s3SecretAccessKey,
    forcePathStyle: cfg.s3ForcePathStyle,
    keyPrefix: cfg.s3KeyPrefix,
  });
}
