/** Immutable snapshot of build settings stored on every deployment (Deployment.settings). */
export interface DeploymentSettings {
  framework: string;
  runtime: 'STATIC' | 'PYTHON';
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  pythonVersion: string | null;
  nodeVersion: string;
  port: number;
  healthCheckPath: string;
  spaFallback: boolean;
  rootDirectory: string;
  repo: { fullName: string; githubRepoId: string; installationId: string } | null;
}

export type Tx = Parameters<Parameters<import('@prisma/client').PrismaClient['$transaction']>[0]>[0];
