import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, createAppJwt, isValidRepoFullName, normalizePrivateKey } from '../src/github';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('GitHub App JWT', () => {
  it('produces a verifiable RS256 token with the app id as issuer', () => {
    const jwt = createAppJwt('12345', privateKey, 1_700_000_000);
    const [h, p, s] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload.iss).toBe('12345');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60 + 30);
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('accepts PEM, escaped-newline PEM and base64 PEM', () => {
    expect(normalizePrivateKey(privateKey)).toBe(privateKey.trim());
    expect(normalizePrivateKey(privateKey.replace(/\n/g, '\\n'))).toBe(privateKey.trim());
    expect(normalizePrivateKey(Buffer.from(privateKey).toString('base64'))).toBe(privateKey.trim());
  });
});

describe('repository name validation', () => {
  it('accepts owner/name and rejects injection attempts', () => {
    expect(isValidRepoFullName('octo-cat/hello.world_1')).toBe(true);
    for (const bad of ['a', 'a/b/c', '../etc', 'a/..', 'a/b?x=1', 'a b/c', 'a/b#c', '', '/b', 'a/']) {
      expect(isValidRepoFullName(bad), bad).toBe(false);
    }
  });
});

describe('GitHubClient', () => {
  const cfg = { apiUrl: 'https://api.github.com', appId: '1', privateKey, clientId: 'cid', clientSecret: 'sec' };

  it('refuses a non-https API url', () => {
    expect(() => new GitHubClient({ ...cfg, apiUrl: 'http://evil.example' })).toThrow(/https/);
  });

  it('reports a configuration error instead of pretending to work', async () => {
    const c = new GitHubClient({ apiUrl: 'https://api.github.com' });
    expect(c.configured).toBe(false);
    await expect(c.installationToken(1)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('requests a read-only, scoped installation token and caches it', async () => {
    const f = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 }),
    );
    const c = new GitHubClient(cfg, f as unknown as typeof fetch);
    expect(await c.installationToken(42)).toBe('ghs_x');
    expect(await c.installationToken(42)).toBe('ghs_x');
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.permissions).toEqual({ contents: 'read', metadata: 'read' });
  });

  it('resolves refs to full commit SHAs and rejects bad refs / repos before any request', async () => {
    const sha = 'b'.repeat(40);
    const f = vi.fn(async (url: string) =>
      url.includes('access_tokens')
        ? new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 })
        : new Response(JSON.stringify({ sha, commit: { message: 'feat: x\n\nbody', author: { name: 'Ada' } } }), { status: 200 }),
    );
    const c = new GitHubClient(cfg, f as unknown as typeof fetch);
    expect(await c.resolveCommit(1, 'o/r', 'main')).toEqual({ sha, message: 'feat: x', author: 'Ada' });
    await expect(c.resolveCommit(1, 'o/r', '../x')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(c.resolveCommit(1, 'o/r/extra', 'main')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('builds credential-free clone urls', () => {
    const c = new GitHubClient(cfg);
    expect(c.cloneUrl('o/r')).toBe('https://github.com/o/r.git');
  });
});
