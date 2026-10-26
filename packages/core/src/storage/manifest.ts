import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validateArtifactPath } from '../paths';
import type { ObjectStorage } from './types';

export const MANIFEST_NAME = 'manifest.json';

export const ManifestFileSchema = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().max(200),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['static', 'python']),
  createdAt: z.string(),
  totalSize: z.number().int().nonnegative(),
  /** static: per-file objects live at `<prefix>/files/<path>`; python: single bundle at `<prefix>/bundle.tar.gz`. */
  files: z.array(ManifestFileSchema),
  spaFallback: z.boolean().default(false),
  bundle: z
    .object({ key: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
    .optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

export const filesKey = (prefix: string, rel: string) => `${prefix}/files/${rel}`;
export const manifestKey = (prefix: string) => `${prefix}/${MANIFEST_NAME}`;
export const bundleKey = (prefix: string) => `${prefix}/bundle.tar.gz`;

export function buildStaticManifest(files: ManifestFile[], spaFallback: boolean): Manifest {
  const seen = new Set<string>();
  for (const f of files) {
    validateArtifactPath(f.path);
    if (seen.has(f.path)) throw new Error(`Duplicate artifact path: ${f.path}`);
    seen.add(f.path);
  }
  return {
    version: 1,
    kind: 'static',
    createdAt: new Date().toISOString(),
    totalSize: files.reduce((n, f) => n + f.size, 0),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    spaFallback,
  };
}

/** Stable checksum over the manifest's file list (what makes the deployment "immutable"). */
export function manifestChecksum(m: Manifest): string {
  const h = createHash('sha256');
  for (const f of m.files) h.update(`${f.path}\0${f.size}\0${f.sha256}\n`);
  if (m.bundle) h.update(`bundle\0${m.bundle.size}\0${m.bundle.sha256}\n`);
  return h.digest('hex');
}

export async function readManifest(storage: ObjectStorage, prefix: string): Promise<Manifest> {
  const { body } = await storage.get(manifestKey(prefix));
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const parsed = ManifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  for (const f of parsed.files) validateArtifactPath(f.path);
  return parsed;
}

/**
 * Validate a published artifact before the deployment may become READY:
 *  - manifest parses and every path is safe
 *  - every referenced object exists with the recorded size
 *  - static deployments contain an index.html (or an SPA fallback target)
 */
export async function validateArtifact(
  storage: ObjectStorage,
  prefix: string,
  expectedChecksum: string,
): Promise<Manifest> {
  const m = await readManifest(storage, prefix);
  if (manifestChecksum(m) !== expectedChecksum) throw new Error('Artifact manifest checksum mismatch');
  if (m.kind === 'static') {
    if (!m.files.some((f) => f.path === 'index.html')) {
      throw new Error('Static build output has no index.html at its root');
    }
    for (const f of m.files) {
      const info = await storage.head(filesKey(prefix, f.path));
      if (!info) throw new Error(`Missing artifact object: ${f.path}`);
      if (info.size !== f.size) throw new Error(`Artifact size mismatch: ${f.path}`);
    }
  } else {
    if (!m.bundle) throw new Error('Python artifact has no bundle');
    const info = await storage.head(m.bundle.key);
    if (!info || info.size !== m.bundle.size) throw new Error('Python bundle missing or size mismatch');
  }
  return m;
}
