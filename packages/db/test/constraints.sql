-- Schema constraint tests. Run against a freshly migrated database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/test/constraints.sql
-- Everything runs in a transaction that is rolled back, and any failed expectation raises.
BEGIN;

CREATE FUNCTION pg_temp.expect_error(label text, stmt text, state text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN
      RAISE NOTICE 'PASS  %', label;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  % (expected %, got % : %)', label, state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % (statement succeeded but should have failed)', label;
END $$ LANGUAGE plpgsql;

-- fixtures ---------------------------------------------------------------------------------------
INSERT INTO "User"(id,email,"updatedAt") VALUES ('u1','a@example.com',now()),('u2','b@example.com',now());
INSERT INTO "Organization"(id,name,slug,"updatedAt") VALUES ('o1','A','a',now()),('o2','B','b',now());
INSERT INTO "OrganizationMember"(id,"orgId","userId",role) VALUES ('m1','o1','u1','OWNER'),('m2','o2','u2','OWNER');
INSERT INTO "Project"(id,"orgId",name,slug,"updatedAt") VALUES ('p1','o1','P1','proj-one',now()),('p2','o2','P2','proj-two',now());
INSERT INTO "GitHubInstallation"(id,"installationId","orgId","accountLogin","accountId","accountType","updatedAt") VALUES ('i1',100,'o1','octo',1,'User',now());
INSERT INTO "RepositoryConnection"(id,"projectId","orgId","installationRef","githubRepoId","fullName","defaultBranch","updatedAt") VALUES ('c1','p1','o1','i1',555,'octo/site','main',now());
INSERT INTO "Deployment"(id,"projectId",branch,"commitSha","idempotencyKey","previewHostname",settings,"updatedAt")
  VALUES ('d1','p1','main',repeat('a',40),'k1','proj-one-aaaaaaaa.localhost','{}',now());

-- uniqueness -------------------------------------------------------------------------------------
SELECT pg_temp.expect_error('duplicate user email rejected',
  $$INSERT INTO "User"(id,email,"updatedAt") VALUES ('u3','a@example.com',now())$$, '23505');
SELECT pg_temp.expect_error('duplicate project slug rejected',
  $$INSERT INTO "Project"(id,"orgId",name,slug,"updatedAt") VALUES ('p3','o2','X','proj-one',now())$$, '23505');
SELECT pg_temp.expect_error('same repo+root cannot be connected twice in one org',
  $$INSERT INTO "Project"(id,"orgId",name,slug,"updatedAt") VALUES ('p4','o1','Y','proj-four',now());
    INSERT INTO "RepositoryConnection"(id,"projectId","orgId","installationRef","githubRepoId","fullName","defaultBranch","updatedAt") VALUES ('c2','p4','o1','i1',555,'octo/site','main',now())$$, '23505');
SELECT pg_temp.expect_error('one repository connection per project',
  $$INSERT INTO "RepositoryConnection"(id,"projectId","orgId","installationRef","githubRepoId","fullName","defaultBranch","rootDirectory","updatedAt") VALUES ('c3','p1','o1','i1',556,'octo/other','main','sub',now())$$, '23505');
SELECT pg_temp.expect_error('duplicate GitHub installation id rejected',
  $$INSERT INTO "GitHubInstallation"(id,"installationId","orgId","accountLogin","accountId","accountType","updatedAt") VALUES ('i2',100,'o2','x',2,'User',now())$$, '23505');
SELECT pg_temp.expect_error('duplicate idempotency key rejected',
  $$INSERT INTO "Deployment"(id,"projectId",branch,"commitSha","idempotencyKey","previewHostname",settings,"updatedAt") VALUES ('d2','p1','main',repeat('b',40),'k1','x-bbbbbbbb.localhost','{}',now())$$, '23505');
SELECT pg_temp.expect_error('duplicate preview hostname rejected',
  $$INSERT INTO "Deployment"(id,"projectId",branch,"commitSha","idempotencyKey","previewHostname",settings,"updatedAt") VALUES ('d3','p1','main',repeat('b',40),'k3','proj-one-aaaaaaaa.localhost','{}',now())$$, '23505');
SELECT pg_temp.expect_error('duplicate webhook delivery id rejected',
  $$INSERT INTO "WebhookDelivery"(id,"deliveryId",event,"payloadSha256") VALUES ('w1','guid-1','push','x'); INSERT INTO "WebhookDelivery"(id,"deliveryId",event,"payloadSha256") VALUES ('w2','guid-1','push','x')$$, '23505');
SELECT pg_temp.expect_error('duplicate log sequence per deployment rejected',
  $$INSERT INTO "DeploymentLog"(id,"deploymentId",seq,message) VALUES ('l1','d1',1,'a'); INSERT INTO "DeploymentLog"(id,"deploymentId",seq,message) VALUES ('l2','d1',1,'b')$$, '23505');
SELECT pg_temp.expect_error('duplicate env key per project+environment rejected',
  $$INSERT INTO "EnvironmentVariable"(id,"projectId",key,environment,"valueEncrypted","keyId","updatedAt") VALUES ('e1','p1','API','PRODUCTION','v1.x',1,now()); INSERT INTO "EnvironmentVariable"(id,"projectId",key,environment,"valueEncrypted","keyId","updatedAt") VALUES ('e2','p1','API','PRODUCTION','v1.y',1,now())$$, '23505');
SELECT pg_temp.expect_error('duplicate usage record per deployment+metric rejected',
  $$INSERT INTO "UsageRecord"(id,"orgId","deploymentId",metric,quantity) VALUES ('r1','o1','d1','DEPLOYMENT',1); INSERT INTO "UsageRecord"(id,"orgId","deploymentId",metric,quantity) VALUES ('r2','o1','d1','DEPLOYMENT',1)$$, '23505');
SELECT pg_temp.expect_error('duplicate build attempt rejected',
  $$INSERT INTO "BuildJob"(id,"deploymentId",attempt,"queueJobId","updatedAt") VALUES ('b1','d1',1,'q',now()); INSERT INTO "BuildJob"(id,"deploymentId",attempt,"queueJobId","updatedAt") VALUES ('b2','d1',1,'q',now())$$, '23505');

-- domain takeover protection ---------------------------------------------------------------------
INSERT INTO "Domain"(id,"projectId",hostname,"challengeToken","updatedAt") VALUES ('dom1','p1','www.example.com','t1',now());
INSERT INTO "Domain"(id,"projectId",hostname,"challengeToken","updatedAt") VALUES ('dom2','p2','www.example.com','t2',now());  -- two pending claims are fine
UPDATE "Domain" SET status='ACTIVE', "activeHostname"=hostname, "verifiedAt"=now() WHERE id='dom1';
SELECT pg_temp.expect_error('a hostname can be ACTIVE for only one project',
  $$UPDATE "Domain" SET status='ACTIVE', "activeHostname"=hostname WHERE id='dom2'$$, '23505');
SELECT pg_temp.expect_error('ACTIVE domain must carry activeHostname',
  $$UPDATE "Domain" SET status='ACTIVE', "activeHostname"=NULL WHERE id='dom2'$$, '23514');
SELECT pg_temp.expect_error('hostnames must be lowercase',
  $$INSERT INTO "Domain"(id,"projectId",hostname,"challengeToken","updatedAt") VALUES ('dom3','p1','WWW.Example.org','t',now())$$, '23514');

-- check constraints ------------------------------------------------------------------------------
SELECT pg_temp.expect_error('commit SHA must be 40 hex chars',
  $$INSERT INTO "Deployment"(id,"projectId",branch,"commitSha","idempotencyKey","previewHostname",settings,"updatedAt") VALUES ('d9','p1','main','nothex','k9','z.localhost','{}',now())$$, '23514');
SELECT pg_temp.expect_error('progress must be 0..100',
  $$UPDATE "Deployment" SET progress = 101 WHERE id='d1'$$, '23514');
SELECT pg_temp.expect_error('port must be valid',
  $$UPDATE "Project" SET port = 70000 WHERE id='p1'$$, '23514');

-- foreign keys / deletion policy -----------------------------------------------------------------
SELECT pg_temp.expect_error('organisation with projects cannot be deleted (RESTRICT)',
  $$DELETE FROM "Organization" WHERE id='o1'$$, '23503');
SELECT pg_temp.expect_error('installation with connections cannot be deleted (RESTRICT)',
  $$DELETE FROM "GitHubInstallation" WHERE id='i1'$$, '23503');
SELECT pg_temp.expect_error('deployment must reference an existing project',
  $$INSERT INTO "Deployment"(id,"projectId",branch,"commitSha","idempotencyKey","previewHostname",settings,"updatedAt") VALUES ('d8','nope','main',repeat('c',40),'k8','q.localhost','{}',now())$$, '23503');

-- cascades ---------------------------------------------------------------------------------------
UPDATE "Project" SET "activeDeploymentId"='d1' WHERE id='p1';
DO $$ BEGIN
  DELETE FROM "Deployment" WHERE id='d1';
  IF (SELECT "activeDeploymentId" FROM "Project" WHERE id='p1') IS NOT NULL THEN RAISE EXCEPTION 'FAIL active pointer not cleared'; END IF;
  IF EXISTS (SELECT 1 FROM "DeploymentLog" WHERE "deploymentId"='d1') THEN RAISE EXCEPTION 'FAIL logs not cascaded'; END IF;
  RAISE NOTICE 'PASS  deleting a deployment clears the active pointer and cascades logs';
END $$;
DO $$ BEGIN
  DELETE FROM "Project" WHERE id='p1';
  IF EXISTS (SELECT 1 FROM "Domain" WHERE "projectId"='p1') OR EXISTS (SELECT 1 FROM "EnvironmentVariable" WHERE "projectId"='p1')
     OR EXISTS (SELECT 1 FROM "RepositoryConnection" WHERE "projectId"='p1') THEN RAISE EXCEPTION 'FAIL project children not cascaded'; END IF;
  RAISE NOTICE 'PASS  deleting a project cascades domains, env vars and repository connection';
END $$;
DO $$ BEGIN
  DELETE FROM "User" WHERE id='u1';
  IF EXISTS (SELECT 1 FROM "OrganizationMember" WHERE "userId"='u1') THEN RAISE EXCEPTION 'FAIL membership not cascaded'; END IF;
  RAISE NOTICE 'PASS  deleting a user removes memberships';
END $$;

ROLLBACK;
