import { describe, expect, it } from 'vitest';
import { route, stripPort, ttlCache, type RouteStore, type RoutedDeployment } from '../src/router';

const dep = (id: string): RoutedDeployment => ({ id, projectId: 'p', runtime: 'STATIC', artifactPrefix: `deployments/p/${id}/a1`, spaFallback: false, port: 8000, runtimeStatus: 'NONE' });

const store: RouteStore = {
  projectActiveByDomain: async (h) => (h === 'www.customer.com' ? dep('custom') : null),
  projectActiveBySlug: async (s) => (s === 'my-app' ? dep('prod') : null),
  readyDeploymentByPreview: async (h) => (h === 'my-app-0a1b2c3d.deployforge.dev' ? dep('preview') : null),
  isRoutableHostname: async () => true,
};
const ROOT = 'deployforge.dev';
const id = async (host: string | undefined) => {
  const r = await route(host, ROOT, store);
  return r.kind === 'deployment' ? `${r.via}:${r.deployment.id}` : `404:${r.reason}`;
};

describe('host routing', () => {
  it('routes production, preview and verified custom domains', async () => {
    expect(await id('my-app.deployforge.dev')).toBe('production:prod');
    expect(await id('MY-APP.deployforge.dev:8080')).toBe('production:prod');
    expect(await id('my-app-0a1b2c3d.deployforge.dev')).toBe('preview:preview');
    expect(await id('www.customer.com')).toBe('custom:custom');
  });

  it('never routes unknown hosts, the root, nested subdomains or malformed hosts', async () => {
    expect(await id('evil.com')).toMatch(/^404/);
    expect(await id('deployforge.dev')).toMatch(/^404/);
    expect(await id('a.b.deployforge.dev')).toMatch(/^404/);
    expect(await id('nope.deployforge.dev')).toMatch(/^404/);
    expect(await id(undefined)).toMatch(/^404/);
    expect(await id('[::1]')).toMatch(/^404/);
    expect(await id('a/b.deployforge.dev')).toMatch(/^404/);
    expect(await id('my-app.deployforge.dev.evil.com')).toMatch(/^404/);
    expect(await id('xmy-app.deployforge.dev')).toMatch(/^404/);
  });

  it('a preview-shaped host for a non-READY deployment falls back to slug lookup, which also 404s', async () => {
    expect(await id('my-app-ffffffff.deployforge.dev')).toMatch(/^404/);
  });
});

describe('helpers', () => {
  it('stripPort', () => {
    expect(stripPort('Example.com:8080')).toBe('example.com');
    expect(stripPort('example.com')).toBe('example.com');
  });

  it('ttlCache loads once within ttl', async () => {
    let n = 0;
    const c = ttlCache<number>(1000);
    await c.get('k', async () => ++n);
    await c.get('k', async () => ++n);
    expect(n).toBe(1);
    c.clear();
    await c.get('k', async () => ++n);
    expect(n).toBe(2);
  });
});
