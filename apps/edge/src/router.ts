import { normalizeHostname } from '@deployforge/core';

/**
 * Hostname -> deployment routing. Pure logic over a `RouteStore` so it is testable without a database.
 *
 *   <slug>.<root>                -> the project's ACTIVE production deployment
 *   <slug>-<8hex>.<root>         -> that exact deployment (preview URL), only while READY
 *   <verified custom domain>     -> the owning project's ACTIVE production deployment
 *
 * A hostname that is not in the database never routes anywhere (no wildcard fallthrough).
 */
export interface RoutedDeployment {
  id: string;
  projectId: string;
  runtime: 'STATIC' | 'PYTHON';
  artifactPrefix: string;
  spaFallback: boolean;
  port: number;
  runtimeStatus: string;
}

export interface RouteStore {
  projectActiveByDomain(hostname: string): Promise<RoutedDeployment | null>;
  projectActiveBySlug(slug: string): Promise<RoutedDeployment | null>;
  readyDeploymentByPreview(hostname: string): Promise<RoutedDeployment | null>;
  isRoutableHostname(hostname: string): Promise<boolean>;
}

export type RouteResult =
  | { kind: 'deployment'; deployment: RoutedDeployment; via: 'preview' | 'production' | 'custom' }
  | { kind: 'not_found'; reason: string };

const PREVIEW_RE = /^(.+)-[0-9a-f]{8}$/;

export function stripPort(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h; // IPv6 literal: never routable
  const i = h.lastIndexOf(':');
  return i === -1 ? h : h.slice(0, i);
}

export async function route(hostHeader: string | undefined, rootDomain: string, store: RouteStore): Promise<RouteResult> {
  if (!hostHeader || hostHeader.length > 300) return { kind: 'not_found', reason: 'missing host' };
  const host = normalizeHostname(stripPort(hostHeader));
  if (!host || host.includes('/') || host.includes(' ')) return { kind: 'not_found', reason: 'invalid host' };
  const root = rootDomain.toLowerCase();

  if (host === root) return { kind: 'not_found', reason: 'root domain' };
  if (host.endsWith(`.${root}`)) {
    const label = host.slice(0, -(root.length + 1));
    if (label.includes('.')) return { kind: 'not_found', reason: 'nested subdomain' };
    if (PREVIEW_RE.test(label)) {
      const d = await store.readyDeploymentByPreview(host);
      if (d) return { kind: 'deployment', deployment: d, via: 'preview' };
    }
    const prod = await store.projectActiveBySlug(label);
    if (prod) return { kind: 'deployment', deployment: prod, via: 'production' };
    return { kind: 'not_found', reason: 'no active deployment' };
  }
  const custom = await store.projectActiveByDomain(host);
  if (custom) return { kind: 'deployment', deployment: custom, via: 'custom' };
  return { kind: 'not_found', reason: 'unknown host' };
}

/** Tiny TTL cache so routing changes (new deploy, rollback) show up within seconds without a DB hit per request. */
export function ttlCache<T>(ttlMs: number, max = 5000) {
  const m = new Map<string, { v: T; exp: number }>();
  return {
    async get(key: string, load: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const hit = m.get(key);
      if (hit && hit.exp > now) return hit.v;
      const v = await load();
      if (m.size >= max) m.delete(m.keys().next().value as string);
      m.set(key, { v, exp: now + ttlMs });
      return v;
    },
    clear: () => m.clear(),
  };
}
