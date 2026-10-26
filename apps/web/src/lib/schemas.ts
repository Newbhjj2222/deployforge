import { z } from 'zod';
import { SLUG_RE, validateSlug } from '@deployforge/core';

// eslint-disable-next-line no-control-regex
const noControl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const command = z.string().trim().min(1).max(1000).refine(noControl, 'Control characters are not allowed');
const relDir = z.string().trim().max(200).refine((s) => !s.startsWith('/') && !s.split('/').includes('..') && !s.includes('\\') && noControl(s), 'Must be a relative path inside the repository');
const branch = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._\-/]+$/, 'Invalid branch name').refine((s) => !s.includes('..') && !s.startsWith('-') && !s.endsWith('/'), 'Invalid branch name');

export const FrameworkEnum = z.enum(['STATIC', 'VITE', 'REACT', 'NEXTJS', 'FASTAPI', 'FLASK', 'OTHER']);

export const BuildSettings = z.object({
  framework: FrameworkEnum,
  installCommand: command.nullable().optional(),
  buildCommand: command.nullable().optional(),
  outputDirectory: relDir.nullable().optional(),
  startCommand: command.nullable().optional(),
  pythonVersion: z.enum(['3.10', '3.11', '3.12', '3.13']).nullable().optional(),
  nodeVersion: z.enum(['20', '22']).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  healthCheckPath: z.string().regex(/^\/[A-Za-z0-9._~\-/]{0,200}$/).optional(),
  spaFallback: z.boolean().optional(),
});

export const CreateProject = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_RE, 'Use lowercase letters, numbers and hyphens')
    .refine((s) => validateSlug(s).ok, 'This name is reserved or invalid')
    .optional(),
  orgId: z.string().min(1).optional(),
  installationId: z.string().min(1),
  repository: z.string().min(3).max(201),
  productionBranch: branch.optional(),
  rootDirectory: relDir.optional(),
  settings: BuildSettings,
});

export const UpdateProject = z
  .object({
    name: z.string().trim().min(1).max(60),
    productionBranch: branch,
    previewDeployments: z.boolean(),
  })
  .merge(BuildSettings.omit({ framework: true }))
  .extend({ framework: FrameworkEnum })
  .partial();

export const CreateDeployment = z.object({
  branch: branch.optional(),
  ref: z.string().regex(/^[A-Za-z0-9._\-/]{1,200}$/).optional(),
  environment: z.enum(['PRODUCTION', 'PREVIEW']).optional(),
});

export const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Letters, digits and underscores; cannot start with a digit');
export const EnvValue = z.string().max(16 * 1024).refine((s) => !s.includes('\0'), 'Invalid value');
export const EnvScopeEnum = z.enum(['BUILD', 'RUNTIME', 'BUILD_AND_RUNTIME']);
export const EnvEnvironment = z.enum(['PRODUCTION', 'PREVIEW']);

export const CreateEnv = z.object({ key: EnvKey, value: EnvValue, environment: EnvEnvironment, scope: EnvScopeEnum.default('BUILD_AND_RUNTIME') });
export const UpdateEnv = z.object({ value: EnvValue.optional(), scope: EnvScopeEnum.optional(), environment: EnvEnvironment });

export const Register = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(200),
});

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(100).optional(),
  q: z.string().max(100).optional(),
  status: z.string().max(40).optional(),
});
