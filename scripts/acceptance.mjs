#!/usr/bin/env node
/**
 * End-to-end acceptance run against a RUNNING development stack (docker compose).
 *
 *   ./scripts/dev.sh up && ./scripts/dev.sh repo static-site
 *   GITHUB_WEBHOOK_SECRET=... node scripts/acceptance.mjs
 *
 * Covers the Definition of Done items that can run without real GitHub / DNS:
 *   authenticate, connect repo, create project, deploy, persisted logs, artifact served at the deployment URL,
 *   signed webhook push -> new deployment, FAILED build does not replace production, recovery, rollback,
 *   duplicate webhook delivery, bad signature, cross-user isolation and secret non-disclosure.
 * Exit code 0 only if every check passed. Nothing here is mocked: it talks to the real HTTP surface.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const APP = process.env.APP_URL ?? 'http://app.localhost:8080';
const EDGE = process.env.EDGE_URL ?? 'http://localhost:8080';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? env.GITHUB_WEBHOOK_SECRET;
const REPO = process.env.REPO ?? 'static-site';
const repoDir = `.data/dev-repos/${REPO}`;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { (ok ? passed++ : failed++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();

class Session {
  constructor() { this.cookies = new Map(); }
  async req(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(APP + path, {
      method, redirect: 'manual',
      headers: { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), origin: APP, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text };
  }
  async login(email, password) {
    const { json } = await this.req('/api/auth/csrf');
    const form = new URLSearchParams({ csrfToken: json.csrfToken, email, password, json: 'true' });
    const res = await fetch(`${APP}/api/auth/callback/credentials`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, body: form });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    return (await this.req('/api/auth/session')).json?.user?.id;
  }
}

async function waitFor(fn, { timeout = 180_000, every = 2000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); }
}
const hostFetch = (host, path = '/') => fetch(EDGE + path, { headers: { host: host.replace(/^https?:\/\//, '') } }).then(async (r) => ({ status: r.status, text: await r.text() }));

async function main() {
  // 0. fixtures
  try { git('rev-parse', 'HEAD'); } catch { console.error(`Create the repo first: ./scripts/dev.sh repo ${REPO}`); process.exit(2); }
  const stamp = Date.now().toString(36);
  const a = new Session(), b = new Session();
  const emailA = `a-${stamp}@example.com`, emailB = `b-${stamp}@example.com`, pw = 'acceptance-password-1';

  // 1. register + authenticate
  for (const [s, e, n] of [[a, emailA, 'Alice'], [b, emailB, 'Bob']]) {
    const r = await s.req('/api/auth/register', { method: 'POST', body: { name: n, email: e, password: pw } });
    check(`register ${n}`, r.status === 201, r.text);
  }
  check('unauthenticated API call is rejected', (await new Session().req('/api/projects')).status === 401);
  check('Alice can sign in', Boolean(await a.login(emailA, pw)));
  check('Bob can sign in', Boolean(await b.login(emailB, pw)));
  check('wrong password is rejected', !(await new Session().login(emailA, 'wrong-password-123')));

  // 2. connect local repository, create project
  const conn = await a.req('/api/github/connect', { method: 'POST', body: { local: true } });
  check('connect local development installation', conn.status === 200, conn.text);
  const inst = conn.json?.installation?.id;
  const repos = await a.req(`/api/github/repositories?installationId=${inst}`);
  const repo = repos.json?.repositories?.find((r) => r.fullName === `local/${REPO}`);
  check('repository is listed', Boolean(repo), repos.text);
  const det = await a.req('/api/github/detect', { method: 'POST', body: { installationId: inst, repository: `local/${REPO}` } });
  check('framework detection runs', det.status === 200 && det.json?.detection, det.text);
  const slug = `acc-${stamp}`;
  const proj = await a.req('/api/projects', { method: 'POST', body: { name: slug, slug, installationId: inst, repository: `local/${REPO}`, settings: { framework: 'OTHER', installCommand: null, buildCommand: 'node build.mjs', outputDirectory: 'dist' } } });
  check('create project', proj.status === 200, proj.text);
  const pid = proj.json?.project?.id;

  // 3. first deployment -> READY, logs persisted, URL serves the built site
  const d1 = (await a.req(`/api/projects/${pid}/deployments`, { method: 'POST', body: {} })).json?.deployment;
  check('deployment created in QUEUED', d1?.status === 'QUEUED', JSON.stringify(d1));
  const ready1 = await waitFor(async () => { const d = (await a.req(`/api/deployments/${d1.id}`)).json?.deployment; return ['READY', 'FAILED'].includes(d?.status) ? d : null; });
  check('first deployment reaches READY', ready1?.status === 'READY', ready1?.failureReason ?? 'timeout');
  const logs1 = await a.req(`/api/deployments/${d1.id}/logs`);
  check('build logs were persisted', (logs1.json?.logs?.length ?? 0) > 3 && logs1.json.logs.some((l) => /Built \d+ bytes/.test(l.message)));
  const prodHost = `${slug}.localhost`;
  const page = await hostFetch(prodHost);
  check('production URL serves the built website', page.status === 200 && page.text.includes('Hello from DeployForge') && !page.text.includes('__BUILT_AT__'), page.text.slice(0, 120));
  const prev = await hostFetch(new URL(ready1.url).host.replace(/:\d+$/, ''));
  check('unique preview URL serves the same build', prev.status === 200 && prev.text.includes('Hello from DeployForge'));
  check('traversal against a deployment host is refused', (await hostFetch(prodHost, '/..%2f..%2f..%2fetc/passwd')).status === 404);

  // 4. signed webhook -> new deployment; duplicate delivery; bad signature
  if (!SECRET) { console.log('SKIP  webhook checks (GITHUB_WEBHOOK_SECRET not set in .env)'); }
  else {
    const push = async (sha, delivery = randomUUID(), secret = SECRET) => {
      const body = JSON.stringify({ ref: 'refs/heads/main', after: sha, repository: { id: Number(repo.id), full_name: `local/${REPO}` }, installation: { id: 0 }, head_commit: { message: git('log', '-1', '--format=%s', sha), author: { name: 't' } } });
      const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
      const res = await fetch(`${APP}/api/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': delivery, 'x-hub-signature-256': sig }, body });
      return { status: res.status, json: await res.json().catch(() => null), delivery };
    };
    const commit = (file, content, msg) => { writeFileSync(`${repoDir}/${file}`, content); git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
    check('webhook with a bad signature is rejected', (await push(git('rev-parse', 'HEAD'), randomUUID(), 'wrong-secret-xxxxxxxx')).status === 401);

    // 4a. good push
    const sha2 = commit('src/index.html', readFileSync(`${repoDir}/src/index.html`, 'utf8').replace('Hello from DeployForge', 'Hello again from DeployForge'), 'v2: update heading');
    const w = await push(sha2);
    check('verified push is accepted and queues a deployment', w.status === 202 && w.json?.deployments?.length === 1, JSON.stringify(w));
    const dup = await push(sha2, w.delivery);
    check('duplicate delivery is ignored', dup.status === 200 && /Duplicate/.test(dup.json?.message ?? ''), JSON.stringify(dup));
    const d2id = w.json?.deployments?.[0];
    const ready2 = await waitFor(async () => { const d = (await a.req(`/api/deployments/${d2id}`)).json?.deployment; return ['READY', 'FAILED'].includes(d?.status) ? d : null; });
    check('pushed commit builds and becomes READY', ready2?.status === 'READY', ready2?.failureReason ?? 'timeout');
    await sleep(4000); // edge routing cache is 3s
    check('production now serves the new version', (await hostFetch(prodHost)).text.includes('Hello again'));

    // 4b. failing build must NOT replace production
    await a.req(`/api/projects/${pid}/env`, { method: 'POST', body: { key: 'FAIL_BUILD', value: '1', environment: 'PRODUCTION', scope: 'BUILD' } });
    const sha3 = commit('src/assets/style.css', 'body{color:red}', 'v3: will fail (FAIL_BUILD=1)');
    const w3 = await push(sha3);
    const d3 = await waitFor(async () => { const d = (await a.req(`/api/deployments/${w3.json?.deployments?.[0]}`)).json?.deployment; return ['READY', 'FAILED'].includes(d?.status) ? d : null; });
    check('failing build is reported as FAILED with a reason', d3?.status === 'FAILED' && Boolean(d3.failureReason), JSON.stringify(d3));
    await sleep(4000);
    check('production still serves the last good deployment', (await hostFetch(prodHost)).text.includes('Hello again'));

    // 4c. recovery
    await a.req(`/api/projects/${pid}/env/FAIL_BUILD?environment=PRODUCTION`, { method: 'DELETE' });
    const sha4 = commit('src/assets/style.css', 'body{color:blue}', 'v4: fixed');
    const w4 = await push(sha4);
    const d4 = await waitFor(async () => { const d = (await a.req(`/api/deployments/${w4.json?.deployments?.[0]}`)).json?.deployment; return ['READY', 'FAILED'].includes(d?.status) ? d : null; });
    check('next successful deployment becomes active', d4?.status === 'READY', d4?.failureReason);

    // 5. rollback to the first deployment
    const rb = await a.req(`/api/deployments/${d1.id}/rollback`, { method: 'POST' });
    check('rollback succeeds', rb.status === 200 && rb.json?.activated === true, rb.text);
    await sleep(4000);
    const rolled = await hostFetch(prodHost);
    check('production serves the rolled-back (original) build', rolled.text.includes('Hello from DeployForge') && !rolled.text.includes('Hello again'));
  }

  // 6. environment variables never leak
  const set = await a.req(`/api/projects/${pid}/env`, { method: 'POST', body: { key: 'API_TOKEN', value: 'super-secret-value-123', environment: 'PRODUCTION' } });
  check('env var created', set.status === 200, set.text);
  const list = await a.req(`/api/projects/${pid}/env`);
  check('env var value is never returned', list.status === 200 && !list.text.includes('super-secret-value-123'));
  const projJson = await a.req(`/api/projects/${pid}`);
  check('project payload contains no secrets', !projJson.text.includes('super-secret-value-123'));

  // 7. cross-user isolation (Bob cannot see or touch Alice's resources; always 404, never 403)
  for (const [name, r] of [
    ['read project', await b.req(`/api/projects/${pid}`)],
    ['list deployments', await b.req(`/api/projects/${pid}/deployments`)],
    ['read deployment', await b.req(`/api/deployments/${d1.id}`)],
    ['read logs', await b.req(`/api/deployments/${d1.id}/logs`)],
    ['read env', await b.req(`/api/projects/${pid}/env`)],
    ['write env', await b.req(`/api/projects/${pid}/env`, { method: 'POST', body: { key: 'X', value: 'y', environment: 'PRODUCTION' } })],
    ['add domain', await b.req(`/api/projects/${pid}/domains`, { method: 'POST', body: { hostname: 'evil.example.com' } })],
    ['cancel', await b.req(`/api/deployments/${d1.id}/cancel`, { method: 'POST' })],
    ['rollback', await b.req(`/api/deployments/${d1.id}/rollback`, { method: 'POST' })],
    ['delete project', await b.req(`/api/projects/${pid}`, { method: 'DELETE' })],
  ]) check(`Bob cannot ${name} (404)`, r.status === 404, `${r.status} ${r.text.slice(0, 100)}`);
  check("Bob's project list does not include Alice's project", !(await b.req('/api/projects')).text.includes(slug));
  const csrf = await fetch(`${APP}/api/projects/${pid}`, { method: 'DELETE', headers: { cookie: [...a.cookies].map(([k, v]) => `${k}=${v}`).join('; '), origin: 'https://evil.example' } });
  check('cross-site (CSRF) mutation is blocked', csrf.status === 403);

  // 8. custom domains: cannot be activated without proof
  const dom = await a.req(`/api/projects/${pid}/domains`, { method: 'POST', body: { hostname: `www.${stamp}-not-verified.example.com` } });
  check('custom domain is created PENDING_VERIFICATION', dom.json?.domain?.status === 'PENDING_VERIFICATION', dom.text);
  const ver = await a.req(`/api/domains/${dom.json?.domain?.id}/verify`, { method: 'POST' });
  check('domain without DNS proof stays unverified', ver.json?.verified === false, ver.text);
  check('wildcard / IP / platform-owned domains are rejected', (await Promise.all(['*.example.com', '10.0.0.1', `x.localhost`].map((h) => a.req(`/api/projects/${pid}/domains`, { method: 'POST', body: { hostname: h } })))).every((r) => r.status === 422));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
