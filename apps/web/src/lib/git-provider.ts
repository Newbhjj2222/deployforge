import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, detectFramework, type Detection, type FileProbe, validateRelativeDir } from '@deployforge/core';
import { config, github, isDevLocalGit } from './env';

const exec = promisify(execFile);
export const LOCAL_INSTALLATION_ID = 0n; // synthetic installation used only with DEV_LOCAL_GIT_ROOT in non-production

export interface RepoInfo {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * One interface over "a real GitHub installation" and "the local development repositories folder".
 * The local mode exists so the whole pipeline can be exercised end-to-end without a GitHub App; it is
 * rejected in production by loadConfig().
 */
export interface InstallationLike {
  installationId: bigint;
}

const isLocal = (i: InstallationLike) => i.installationId === LOCAL_INSTALLATION_ID;

function localRepoPath(name: string): string {
  const root = config().DEV_LOCAL_GIT_ROOT;
  if (!root || !isDevLocalGit()) throw new AppError('not_configured', 'Local repositories are not enabled.');
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw new AppError('bad_request', 'Invalid repository name');
  return path.join(root, name);
}

export async function listRepos(inst: InstallationLike): Promise<RepoInfo[]> {
  if (isLocal(inst)) {
    const root = config().DEV_LOCAL_GIT_ROOT;
    if (!root || !isDevLocalGit()) return [];
    const out: RepoInfo[] = [];
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      try {
        await stat(path.join(root, e.name, '.git'));
        const { stdout } = await exec('git', ['-C', path.join(root, e.name), 'symbolic-ref', '--short', 'HEAD']);
        out.push({ id: String(out.length + 1), fullName: `local/${e.name}`, private: true, defaultBranch: stdout.trim() || 'main' });
      } catch {
        /* not a git repo */
      }
    }
    return out;
  }
  const repos = await github().listRepositories(Number(inst.installationId));
  return repos.filter((r) => !r.archived).map((r) => ({ id: String(r.id), fullName: r.full_name, private: r.private, defaultBranch: r.default_branch }));
}

export async function resolveCommit(inst: InstallationLike, fullName: string, ref: string) {
  if (isLocal(inst)) {
    const dir = localRepoPath(fullName.replace(/^local\//, ''));
    if (!/^[A-Za-z0-9._\-/]{1,200}$/.test(ref) || ref.startsWith('-')) throw new AppError('bad_request', 'Invalid ref');
    try {
      const { stdout } = await exec('git', ['-C', dir, 'log', '-1', '--format=%H%n%an%n%s', `${ref}^{commit}`, '--']);
      const [sha, author, message] = stdout.trim().split('\n');
      return { sha: sha!, author: author ?? '', message: message ?? '' };
    } catch {
      throw new AppError('not_found', 'Ref not found');
    }
  }
  return github().resolveCommit(Number(inst.installationId), fullName, ref);
}

export function probeFor(inst: InstallationLike, fullName: string, sha: string, rootDirectory = ''): FileProbe {
  const root = validateRelativeDir(rootDirectory);
  const rel = (p: string) => (root ? `${root}/${p}` : p);
  if (isLocal(inst)) {
    const dir = localRepoPath(fullName.replace(/^local\//, ''));
    return {
      async read(p) {
        try {
          const { stdout } = await exec('git', ['-C', dir, 'show', `${sha}:${rel(p)}`], { maxBuffer: 512 * 1024 });
          return stdout;
        } catch {
          return null;
        }
      },
    };
  }
  return { read: (p) => github().readFile(Number(inst.installationId), fullName, rel(p), sha) };
}

export async function detect(inst: InstallationLike, fullName: string, ref: string, rootDirectory = ''): Promise<Detection & { sha: string }> {
  const { sha } = await resolveCommit(inst, fullName, ref);
  const d = await detectFramework(probeFor(inst, fullName, sha, rootDirectory));
  return { ...d, sha };
}
