import { z } from 'zod';
import { api, parseBody, serialize } from '@/lib/api';
import { connectGitHubInstallation, connectLocalInstallation } from '@/lib/github-install';

const Body = z.union([
  z.object({ local: z.literal(true), orgId: z.string().optional() }),
  z.object({ installationId: z.number().int().positive(), code: z.string().min(1).max(200), orgId: z.string().optional() }),
]);

export const POST = api(
  async ({ req, userId }) => {
    const body = await parseBody(req, Body);
    const row = 'local' in body ? await connectLocalInstallation(userId, body.orgId) : await connectGitHubInstallation(userId, body.installationId, body.code, body.orgId);
    return serialize({ installation: { id: row.id, accountLogin: row.accountLogin, status: row.status } });
  },
  { bucket: 'gh-connect', limit: 20, windowSec: 600 },
);
