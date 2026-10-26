import { DeploymentView } from './deployment-view';

export const metadata = { title: 'Deployment' };

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeploymentView id={id} />;
}
