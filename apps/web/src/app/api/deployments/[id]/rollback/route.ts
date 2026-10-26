import { requireDeployment, rollbackTo } from '@deployforge/db';
import { api } from '@/lib/api';

/** Roll back = re-activate this previously successful, immutable production deployment. */
export const POST = api<{ id: string }>(async ({ userId, params }) => {
  await requireDeployment(userId, params.id, 'ADMIN');
  return rollbackTo(params.id, userId);
});
