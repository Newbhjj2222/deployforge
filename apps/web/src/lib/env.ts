import 'server-only';
import { GitHubClient, loadConfig, type SharedConfig } from '@deployforge/core';

declare global {
  // eslint-disable-next-line no-var
  var __df_cfg: SharedConfig | undefined;
  // eslint-disable-next-line no-var
  var __df_gh: GitHubClient | undefined;
}

/** Validated once per process. Throws a descriptive error at first use if the environment is wrong. */
export function config(): SharedConfig {
  return (globalThis.__df_cfg ??= loadConfig());
}

export function github(): GitHubClient {
  const c = config();
  return (globalThis.__df_gh ??= new GitHubClient({
    apiUrl: c.GITHUB_API_URL,
    appId: c.GITHUB_APP_ID,
    privateKey: c.GITHUB_APP_PRIVATE_KEY,
    clientId: c.GITHUB_CLIENT_ID,
    clientSecret: c.GITHUB_CLIENT_SECRET,
  }));
}

export const isDevLocalGit = () => Boolean(config().DEV_LOCAL_GIT_ROOT) && config().NODE_ENV !== 'production';
