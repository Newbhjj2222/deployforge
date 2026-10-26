import { createPrivateKey, createSign } from 'node:crypto';
import { z } from 'zod';
import { AppError, notConfigured } from './errors';

/**
 * Minimal GitHub App client (fetch-based, injectable for tests).
 * All requests go to a fixed, validated API base URL - user input never selects the host (SSRF).
 */
export interface GitHubAppConfig {
  apiUrl: string;
  appId?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
}

const REPO_PART = /^[A-Za-z0-9._-]{1,100}$/;
export const isValidRepoFullName = (full: string) => {
  const parts = full.split('/');
  return parts.length === 2 && parts.every((p) => REPO_PART.test(p) && p !== '.' && p !== '..');
};

export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN')) return trimmed.replace(/\\n/g, '\n').trim();
  return Buffer.from(trimmed, 'base64').toString('utf8').trim();
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function createAppJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

const InstallationSchema = z.object({
  id: z.number(),
  account: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable(),
  suspended_at: z.string().nullable().optional(),
  permissions: z.record(z.string()).optional(),
});
export type GitHubInstallationInfo = z.infer<typeof InstallationSchema>;

const RepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
  archived: z.boolean().optional(),
});
export type GitHubRepo = z.infer<typeof RepoSchema>;

type FetchLike = typeof fetch;

export class GitHubClient {
  private tokenCache = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    private readonly cfg: GitHubAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    const u = new URL(cfg.apiUrl);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
      throw new Error('GITHUB_API_URL must use https');
    }
  }

  get configured() {
    return Boolean(this.cfg.appId && this.cfg.privateKey);
  }

  private requireApp() {
    if (!this.cfg.appId || !this.cfg.privateKey) {
      throw notConfigured(
        'GitHub App is not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (see docs/github-app.md).',
      );
    }
    return { appId: this.cfg.appId, key: normalizePrivateKey(this.cfg.privateKey) };
  }

  private async request<T>(path: string, init: RequestInit & { schema: z.ZodType<T>; token: string }): Promise<T> {
    const { schema, token, ...rest } = init;
    const res = await this.fetchImpl(`${this.cfg.apiUrl}${path}`, {
      ...rest,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'deployforge',
        authorization: `Bearer ${token}`,
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new AppError('not_found', 'GitHub resource not found or not accessible');
    if (res.status === 401 || res.status === 403) {
      throw new AppError('upstream_error', 'GitHub rejected the request (check app permissions)');
    }
    if (!res.ok) throw new AppError('upstream_error', `GitHub API error (${res.status})`);
    return schema.parse(await res.json());
  }

  async getInstallation(installationId: number): Promise<GitHubInstallationInfo> {
    const { appId, key } = this.requireApp();
    return this.request(`/app/installations/${installationId}`, {
      token: createAppJwt(appId, key),
      schema: InstallationSchema,
    });
  }

  /** Short-lived, repository-scoped read-only installation token. */
  async installationToken(installationId: number, opts: { repositoryIds?: number[] } = {}): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (!opts.repositoryIds && cached && cached.expiresAt - Date.now() > 120_000) return cached.token;
    const { appId, key } = this.requireApp();
    const r = await this.request(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      token: createAppJwt(appId, key),
      schema: z.object({ token: z.string(), expires_at: z.string() }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        permissions: { contents: 'read', metadata: 'read' },
        ...(opts.repositoryIds ? { repository_ids: opts.repositoryIds } : {}),
      }),
    });
    if (!opts.repositoryIds) {
      this.tokenCache.set(installationId, { token: r.token, expiresAt: Date.parse(r.expires_at) });
    }
    return r.token;
  }

  async listRepositories(installationId: number): Promise<GitHubRepo[]> {
    const token = await this.installationToken(installationId);
    const out: GitHubRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.request(`/installation/repositories?per_page=100&page=${page}`, {
        token,
        schema: z.object({ total_count: z.number(), repositories: z.array(RepoSchema) }),
      });
      out.push(...r.repositories);
      if (out.length >= r.total_count || r.repositories.length === 0) break;
    }
    return out;
  }

  async getRepository(installationId: number, fullName: string): Promise<GitHubRepo> {
    if (!isValidRepoFullName(fullName)) throw new AppError('bad_request', 'Invalid repository name');
    const token = await this.installationToken(installationId);
    return this.request(`/repos/${fullName}`, { token, schema: RepoSchema });
  }

  /** Resolve a branch/tag/sha to an immutable commit SHA. */
  async resolveCommit(
    installationId: number,
    fullName: string,
    ref: string,
  ): Promise<{ sha: string; message: string; author: string }> {
    if (!isValidRepoFullName(fullName)) throw new AppError('bad_request', 'Invalid repository name');
    if (!/^[A-Za-z0-9._\-/]{1,250}$/.test(ref) || ref.includes('..')) {
      throw new AppError('bad_request', 'Invalid ref');
    }
    const token = await this.installationToken(installationId);
    const r = await this.request(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`, {
      token,
      schema: z.object({
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        commit: z.object({ message: z.string(), author: z.object({ name: z.string() }).nullable() }),
      }),
    });
    return { sha: r.sha, message: r.commit.message.split('\n')[0]!.slice(0, 200), author: r.commit.author?.name ?? '' };
  }

  /** Read one file at a commit (used for framework detection). Returns null when absent. */
  async readFile(installationId: number, fullName: string, path: string, ref: string): Promise<string | null> {
    if (!isValidRepoFullName(fullName)) throw new AppError('bad_request', 'Invalid repository name');
    const token = await this.installationToken(installationId);
    const url = `${this.cfg.apiUrl}/repos/${fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    const res = await this.fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github.raw+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'deployforge',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new AppError('upstream_error', `GitHub API error (${res.status})`);
    const text = await res.text();
    return text.length > 512 * 1024 ? null : text;
  }

  /**
   * Verify that the *signed-in user* can access an installation: exchange the OAuth `code` GitHub
   * sends to the Setup URL, then list the user's installations. Without this check anyone could
   * claim an arbitrary installation id.
   */
  async userCanAccessInstallation(code: string, installationId: number): Promise<boolean> {
    const { clientId, clientSecret } = this.cfg;
    if (!clientId || !clientSecret) {
      throw notConfigured('GitHub OAuth credentials are not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).');
    }
    const oauthBase = new URL(this.cfg.apiUrl).hostname === 'api.github.com' ? 'https://github.com' : new URL(this.cfg.apiUrl).origin;
    const tokRes = await this.fetchImpl(`${oauthBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'deployforge' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      signal: AbortSignal.timeout(15_000),
    });
    const tok = z.object({ access_token: z.string().optional() }).parse(await tokRes.json());
    if (!tok.access_token) return false;
    const r = await this.request('/user/installations?per_page=100', {
      token: tok.access_token,
      schema: z.object({ installations: z.array(z.object({ id: z.number() })) }),
    });
    return r.installations.some((i) => i.id === installationId);
  }

  /** HTTPS clone URL without credentials; the token is passed separately to the sandbox. */
  cloneUrl(fullName: string): string {
    if (!isValidRepoFullName(fullName)) throw new AppError('bad_request', 'Invalid repository name');
    const host = new URL(this.cfg.apiUrl).hostname === 'api.github.com' ? 'https://github.com' : new URL(this.cfg.apiUrl).origin;
    return `${host}/${fullName}.git`;
  }
}
