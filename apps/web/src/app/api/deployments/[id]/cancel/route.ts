import { requestCancel, requireDeployment } from '@deployforge/db';
import { api } from '@/lib/api';

export const POST = api<{ id: string }>(async ({ userId, params }) => {
  await requireDeployment(userId, params.id, 'MEMBER');
  const status = await requestCancel(params.id, userId);
  return { status };
});
