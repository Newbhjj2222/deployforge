import { randomHex } from './crypto';

/** Names that can never be a project slug because they would shadow platform hostnames. */
export const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'admin', 'dashboard', 'console', 'dev', 'staging', 'prod', 'production',
  'mail', 'smtp', 'imap', 'ns', 'ns1', 'ns2', 'ftp', 'cdn', 'static', 'assets', 'edge', 'proxy',
  'status', 'docs', 'help', 'support', 'blog', 'login', 'auth', 'oauth', 'internal', 'localhost',
  'deployforge', 'root', 'system', 'git', 'github', 'preview', 'previews',
]);

/** Preview hostnames look like `<slug>-<8 hex>`; project slugs may not look like that. */
const PREVIEW_SUFFIX = /-[0-9a-f]{8}$/;

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s;
}

export function validateSlug(slug: string): { ok: true } | { ok: false; reason: string } {
  if (!SLUG_RE.test(slug)) {
    return { ok: false, reason: 'Use 1-40 lowercase letters, numbers and hyphens (no leading/trailing hyphen).' };
  }
  if (slug.includes('--')) return { ok: false, reason: 'Slug may not contain consecutive hyphens.' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'This name is reserved.' };
  if (PREVIEW_SUFFIX.test(slug)) {
    return { ok: false, reason: 'Slug may not end with a hyphen and 8 hex characters.' };
  }
  return { ok: true };
}

export const newPreviewHostname = (slug: string, rootDomain: string) =>
  `${slug}-${randomHex(4)}.${rootDomain}`;

export const productionHostname = (slug: string, rootDomain: string) => `${slug}.${rootDomain}`;
