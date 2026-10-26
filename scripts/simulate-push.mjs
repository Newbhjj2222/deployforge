#!/usr/bin/env node
// Sends a correctly SIGNED GitHub `push` webhook to a local stack for a repository created with
// `./scripts/dev.sh repo <name>`. Exercises the real webhook path (HMAC, dedupe, outbox) without GitHub.
// Requires the project to be connected to local/<name>, and GITHUB_WEBHOOK_SECRET set in .env.
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [name, branchArg] = process.argv.slice(2);
if (!name) { console.error('usage: simulate-push.mjs <repo-name> [branch]'); process.exit(1); }
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const secret = process.env.GITHUB_WEBHOOK_SECRET || env.GITHUB_WEBHOOK_SECRET;
if (!secret) { console.error('GITHUB_WEBHOOK_SECRET is not set in .env'); process.exit(1); }
const dir = `.data/dev-repos/${name}`;
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const branch = branchArg || git('symbolic-ref', '--short', 'HEAD');
const sha = git('rev-parse', branch);
const msg = git('log', '-1', '--format=%s', sha);
const repoId = Number(process.env.REPO_ID || 1);
const body = JSON.stringify({
  ref: `refs/heads/${branch}`, after: sha, deleted: false,
  repository: { id: repoId, full_name: `local/${name}` }, installation: { id: 0 },
  head_commit: { message: msg, author: { name: 'dev' } },
});
const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const url = process.env.WEBHOOK_URL || `http://app.localhost:8080/api/webhooks/github`;
const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': sig }, body });
console.log(res.status, await res.text());
