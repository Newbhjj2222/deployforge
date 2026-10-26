-- DeployForge initial schema.
-- NOTE: authored by hand to mirror prisma/schema.prisma (the sandbox this repo was generated in had no
-- access to the npm registry, so `prisma migrate dev` could not be run). CI runs
-- `prisma migrate diff --from-migrations ... --to-schema-datamodel ... --exit-code` to guarantee that
-- this file and the schema never drift; regenerate with `npm run db:migrate:dev` if that check fails.

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
CREATE TYPE "Framework" AS ENUM ('STATIC', 'VITE', 'REACT', 'NEXTJS', 'FASTAPI', 'FLASK', 'OTHER');
CREATE TYPE "RuntimeKind" AS ENUM ('STATIC', 'PYTHON');
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING', 'READY', 'FAILED', 'CANCELING', 'CANCELED');
CREATE TYPE "DeploymentEnvironment" AS ENUM ('PRODUCTION', 'PREVIEW');
CREATE TYPE "DeploymentTrigger" AS ENUM ('MANUAL', 'WEBHOOK', 'ROLLBACK');
CREATE TYPE "RuntimeStatus" AS ENUM ('NONE', 'STARTING', 'RUNNING', 'STOPPED', 'FAILED');
CREATE TYPE "EnvScope" AS ENUM ('BUILD', 'RUNTIME', 'BUILD_AND_RUNTIME');
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');
CREATE TYPE "TlsStatus" AS ENUM ('UNKNOWN', 'PENDING', 'ACTIVE', 'EXPIRING', 'FAILED');
CREATE TYPE "InstallationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "BuildJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'DEAD');
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');
CREATE TYPE "LogStream" AS ENUM ('SYSTEM', 'STDOUT', 'STDERR');
CREATE TYPE "UsageMetric" AS ENUM ('DEPLOYMENT', 'BUILD_SECONDS', 'ARTIFACT_BYTES');
CREATE TYPE "ProjectState" AS ENUM ('ACTIVE', 'DELETING');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "state" "ProjectState" NOT NULL DEFAULT 'ACTIVE',
    "framework" "Framework" NOT NULL DEFAULT 'OTHER',
    "runtime" "RuntimeKind" NOT NULL DEFAULT 'STATIC',
    "productionBranch" TEXT NOT NULL DEFAULT 'main',
    "installCommand" TEXT,
    "buildCommand" TEXT,
    "outputDirectory" TEXT,
    "startCommand" TEXT,
    "pythonVersion" TEXT,
    "nodeVersion" TEXT NOT NULL DEFAULT '22',
    "port" INTEGER NOT NULL DEFAULT 8000,
    "healthCheckPath" TEXT NOT NULL DEFAULT '/health',
    "spaFallback" BOOLEAN NOT NULL DEFAULT false,
    "previewDeployments" BOOLEAN NOT NULL DEFAULT true,
    "activeDeploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GitHubInstallation" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "orgId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "accountType" TEXT NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GitHubInstallation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RepositoryConnection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "installationRef" TEXT NOT NULL,
    "githubRepoId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "rootDirectory" TEXT NOT NULL DEFAULT '',
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RepositoryConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "trigger" "DeploymentTrigger" NOT NULL DEFAULT 'MANUAL',
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "commitMessage" TEXT,
    "commitAuthor" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT,
    "previewHostname" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "runtime" "RuntimeKind" NOT NULL DEFAULT 'STATIC',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "rollbackOfId" TEXT,
    "artifactPrefix" TEXT,
    "artifactChecksum" TEXT,
    "artifactBytes" BIGINT,
    "fileCount" INTEGER,
    "runtimeStatus" "RuntimeStatus" NOT NULL DEFAULT 'NONE',
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeploymentLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "stream" "LogStream" NOT NULL DEFAULT 'SYSTEM',
    "message" TEXT NOT NULL,
    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BuildJob" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "BuildJobStatus" NOT NULL DEFAULT 'PENDING',
    "queueJobId" TEXT NOT NULL,
    "workerId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BuildJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "activeHostname" TEXT,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "challengeToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "verificationFailures" INTEGER NOT NULL DEFAULT 0,
    "tlsStatus" "TlsStatus" NOT NULL DEFAULT 'UNKNOWN',
    "tlsExpiresAt" TIMESTAMP(3),
    "tlsCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnvironmentVariable" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "scope" "EnvScope" NOT NULL DEFAULT 'BUILD_AND_RUNTIME',
    "valueEncrypted" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EnvironmentVariable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "installationId" BIGINT,
    "repoId" BIGINT,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "detail" TEXT,
    "payloadSha256" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "projectId" TEXT,
    "deploymentId" TEXT,
    "metric" "UsageMetric" NOT NULL,
    "quantity" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");
CREATE UNIQUE INDEX "OrganizationMember_orgId_userId_key" ON "OrganizationMember"("orgId", "userId");
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE UNIQUE INDEX "Project_activeDeploymentId_key" ON "Project"("activeDeploymentId");
CREATE INDEX "Project_orgId_createdAt_idx" ON "Project"("orgId", "createdAt" DESC);
CREATE INDEX "Project_state_idx" ON "Project"("state");
CREATE UNIQUE INDEX "GitHubInstallation_installationId_key" ON "GitHubInstallation"("installationId");
CREATE INDEX "GitHubInstallation_orgId_idx" ON "GitHubInstallation"("orgId");
CREATE UNIQUE INDEX "RepositoryConnection_projectId_key" ON "RepositoryConnection"("projectId");
CREATE INDEX "RepositoryConnection_githubRepoId_idx" ON "RepositoryConnection"("githubRepoId");
CREATE INDEX "RepositoryConnection_installationRef_idx" ON "RepositoryConnection"("installationRef");
CREATE UNIQUE INDEX "RepositoryConnection_orgId_githubRepoId_rootDirectory_key" ON "RepositoryConnection"("orgId", "githubRepoId", "rootDirectory");
CREATE UNIQUE INDEX "Deployment_idempotencyKey_key" ON "Deployment"("idempotencyKey");
CREATE UNIQUE INDEX "Deployment_previewHostname_key" ON "Deployment"("previewHostname");
CREATE INDEX "Deployment_projectId_createdAt_idx" ON "Deployment"("projectId", "createdAt" DESC);
CREATE INDEX "Deployment_projectId_environment_status_idx" ON "Deployment"("projectId", "environment", "status");
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");
CREATE INDEX "DeploymentLog_ts_idx" ON "DeploymentLog"("ts");
CREATE UNIQUE INDEX "DeploymentLog_deploymentId_seq_key" ON "DeploymentLog"("deploymentId", "seq");
CREATE INDEX "BuildJob_status_createdAt_idx" ON "BuildJob"("status", "createdAt");
CREATE INDEX "BuildJob_queueJobId_idx" ON "BuildJob"("queueJobId");
CREATE UNIQUE INDEX "BuildJob_deploymentId_attempt_key" ON "BuildJob"("deploymentId", "attempt");
CREATE UNIQUE INDEX "Domain_activeHostname_key" ON "Domain"("activeHostname");
CREATE INDEX "Domain_hostname_idx" ON "Domain"("hostname");
CREATE INDEX "Domain_status_lastCheckedAt_idx" ON "Domain"("status", "lastCheckedAt");
CREATE UNIQUE INDEX "Domain_projectId_hostname_key" ON "Domain"("projectId", "hostname");
CREATE INDEX "EnvironmentVariable_projectId_idx" ON "EnvironmentVariable"("projectId");
CREATE UNIQUE INDEX "EnvironmentVariable_projectId_key_environment_key" ON "EnvironmentVariable"("projectId", "key", "environment");
CREATE UNIQUE INDEX "WebhookDelivery_deliveryId_key" ON "WebhookDelivery"("deliveryId");
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");
CREATE INDEX "WebhookDelivery_status_idx" ON "WebhookDelivery"("status");
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");
CREATE INDEX "OutboxEvent_aggregateId_idx" ON "OutboxEvent"("aggregateId");
CREATE INDEX "AuditLog_orgId_createdAt_idx" ON "AuditLog"("orgId", "createdAt" DESC);
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
CREATE INDEX "UsageRecord_orgId_metric_createdAt_idx" ON "UsageRecord"("orgId", "metric", "createdAt");
CREATE UNIQUE INDEX "UsageRecord_deploymentId_metric_key" ON "UsageRecord"("deploymentId", "metric");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_activeDeploymentId_fkey" FOREIGN KEY ("activeDeploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GitHubInstallation" ADD CONSTRAINT "GitHubInstallation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_installationRef_fkey" FOREIGN KEY ("installationRef") REFERENCES "GitHubInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_rollbackOfId_fkey" FOREIGN KEY ("rollbackOfId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BuildJob" ADD CONSTRAINT "BuildJob_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnvironmentVariable" ADD CONSTRAINT "EnvironmentVariable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-added integrity checks (not expressible in the Prisma schema; Prisma ignores CHECK constraints).
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_commitSha_format" CHECK ("commitSha" ~ '^[0-9a-f]{40}$');
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_progress_range" CHECK ("progress" BETWEEN 0 AND 100);
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_hostname_lowercase" CHECK ("hostname" = lower("hostname"));
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_active_hostname_consistent"
  CHECK (("status" = 'PENDING_VERIFICATION' AND "activeHostname" IS NULL)
      OR ("status" <> 'PENDING_VERIFICATION' AND "activeHostname" IS NOT NULL AND "activeHostname" = "hostname"));
ALTER TABLE "Project" ADD CONSTRAINT "Project_port_range" CHECK ("port" BETWEEN 1 AND 65535);
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_seq_positive" CHECK ("seq" >= 0);
