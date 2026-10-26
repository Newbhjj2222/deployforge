import { requireDomain, verifyDomain } from '@deployforge/db';
import { api } from '@/lib/api';
import { resolveTxt } from '@/lib/dns';

export const POST = api<{ id: string }>(
  async ({ userId, params }) => {
    await requireDomain(userId, params.id, 'ADMIN');
    return verifyDomain(params.id, resolveTxt, userId);
  },
  { bucket: 'domain-verify', limit: 20, windowSec: 300 },
);
