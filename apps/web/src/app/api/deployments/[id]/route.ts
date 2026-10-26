import { requireDeployment } from '@deployforge/db';
import { api, serialize } from '@/lib/api';
import { deploymentDto } from '@/lib/serialize';

export const GET = api<{ id: string }>(async ({ userId, params }) => {
  const { deployment, project } = await requireDeployment(userId, params.id);
  return serialize({ deployment: deploymentDto(deployment), isActive: project.activeDeploymentId === deployment.id });
});
