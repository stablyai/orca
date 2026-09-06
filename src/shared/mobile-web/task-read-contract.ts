import { z } from 'zod'

import { MobileWebCreationTrustedHooksResultSchema } from './workspace-creation-read-contract'

const EmptyPayloadSchema = z.object({}).strict()
const TaskProviderSchema = z.enum(['github', 'gitlab', 'linear'])
const GitHubPresetSchema = z.enum(['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all'])
const LinearPresetSchema = z.enum(['assigned', 'created', 'all', 'completed'])
const TaskRepoIdSchema = z.string().min(1).max(128)

const GitHubProjectRefSchema = z
  .object({
    owner: z.string().min(1).max(160),
    ownerType: z.enum(['organization', 'user']),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    host: z.string().min(1).max(253).optional()
  })
  .strict()

const GitHubProjectSettingsSchema = z
  .object({
    pinned: z.array(GitHubProjectRefSchema).max(100),
    recent: z
      .array(
        GitHubProjectRefSchema.extend({
          lastOpenedAt: z.string().max(64)
        }).strict()
      )
      .max(100),
    lastViewByProject: z
      .record(z.string().min(1).max(512), z.object({ viewId: z.string().min(1).max(160) }).strict())
      .refine((value) => Object.keys(value).length <= 200),
    activeProject: GitHubProjectRefSchema.nullable()
  })
  .strict()

export const MobileWebTaskResumeStateSchema = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: GitHubPresetSchema.nullable().optional(),
    githubItemsQuery: z.string().max(2_000).optional(),
    githubProjectHiddenFieldIdsByView: z
      .record(z.string().min(1).max(512), z.array(z.string().min(1).max(160)).max(200))
      .refine((value) => Object.keys(value).length <= 200)
      .optional(),
    linearPreset: LinearPresetSchema.optional(),
    linearQuery: z.string().max(2_000).optional()
  })
  .strict()

export const MobileWebRuntimeTaskSettingsSchema = z
  .object({
    defaultTuiAgent: z.string().min(1).max(64).nullable().optional(),
    disabledTuiAgents: z.array(z.string().min(1).max(64)).max(64).optional(),
    agentCmdOverrides: z
      .record(z.string().min(1).max(64), z.string().max(4_096))
      .refine((value) => Object.keys(value).length <= 64)
      .optional(),
    defaultTaskSource: TaskProviderSchema.optional(),
    defaultTaskViewPreset: GitHubPresetSchema.optional(),
    visibleTaskProviders: z.array(TaskProviderSchema).max(3).optional(),
    defaultRepoSelection: z.array(TaskRepoIdSchema).max(10_000).nullable().optional(),
    defaultLinearTeamSelection: z
      .array(z.string().min(1).max(160))
      .max(1_000)
      .nullable()
      .optional(),
    githubProjects: GitHubProjectSettingsSchema.optional()
  })
  .strict()

const LinearWorkspaceSchema = z
  .object({
    id: z.string().min(1).max(160),
    organizationName: z.string().max(240).optional(),
    displayName: z.string().max(240).optional()
  })
  .strict()

const LinearStatusSchema = z
  .object({
    connected: z.boolean(),
    workspaces: z.array(LinearWorkspaceSchema).max(1_000),
    selectedWorkspaceId: z.string().min(1).max(160).nullable(),
    activeWorkspaceId: z.string().min(1).max(160).nullable()
  })
  .strict()

export const MobileWebTaskBootstrapPayloadSchema = EmptyPayloadSchema
export const MobileWebTaskBootstrapResultSchema = z
  .object({
    supported: z.boolean(),
    settings: MobileWebRuntimeTaskSettingsSchema,
    taskResumeState: MobileWebTaskResumeStateSchema,
    trustedOrcaHooks: MobileWebCreationTrustedHooksResultSchema,
    gitLabInstalled: z.boolean(),
    linearStatus: LinearStatusSchema
  })
  .strict()

export const MobileWebTaskRepositoriesPayloadSchema = EmptyPayloadSchema
export const MobileWebTaskRepositoriesResultSchema = z
  .object({
    repositories: z
      .array(
        z
          .object({
            id: TaskRepoIdSchema,
            displayName: z.string().min(1).max(240),
            path: z.string().max(4_096),
            badgeColor: z.string().max(64).optional(),
            kind: z.enum(['git', 'folder']).optional(),
            connectionId: TaskRepoIdSchema.nullable().optional(),
            issueSourcePreference: z.enum(['upstream', 'origin', 'auto']).optional()
          })
          .strict()
      )
      .max(10_000)
  })
  .strict()

export const MobileWebTaskLinearContextPayloadSchema = EmptyPayloadSchema
export const MobileWebTaskLinearContextResultSchema = z
  .object({
    status: LinearStatusSchema,
    teams: z
      .array(
        z
          .object({
            id: z.string().min(1).max(160),
            workspaceId: z.string().min(1).max(160).optional(),
            workspaceName: z.string().max(240).optional(),
            name: z.string().min(1).max(240),
            key: z.string().min(1).max(80)
          })
          .strict()
      )
      .max(10_000)
  })
  .strict()

export const MobileWebTaskRepoPayloadSchema = z.object({ repoId: TaskRepoIdSchema }).strict()
export const MobileWebTaskRepoSlugResultSchema = z
  .object({
    repository: z
      .object({
        owner: z.string().min(1).max(160),
        repo: z.string().min(1).max(240),
        host: z.string().min(1).max(253).optional()
      })
      .strict()
      .nullable()
  })
  .strict()

export const MobileWebTaskResumeUpdatePayloadSchema = z
  .object({ taskResumeState: MobileWebTaskResumeStateSchema })
  .strict()
export const MobileWebTaskSettingsUpdatePayloadSchema = z
  .object({
    defaultTaskSource: TaskProviderSchema.optional(),
    defaultTaskViewPreset: GitHubPresetSchema.optional(),
    defaultRepoSelection: z.array(TaskRepoIdSchema).max(10_000).nullable().optional(),
    defaultLinearTeamSelection: z
      .array(z.string().min(1).max(160))
      .max(1_000)
      .nullable()
      .optional(),
    githubProjects: GitHubProjectSettingsSchema.optional()
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined))
export const MobileWebTaskPreferenceUpdateResultSchema = z.null()

export type MobileWebTaskBootstrapResult = z.infer<typeof MobileWebTaskBootstrapResultSchema>
export type MobileWebTaskRepositoriesResult = z.infer<typeof MobileWebTaskRepositoriesResultSchema>
export type MobileWebTaskLinearContextResult = z.infer<
  typeof MobileWebTaskLinearContextResultSchema
>
export type MobileWebTaskRepoPayload = z.infer<typeof MobileWebTaskRepoPayloadSchema>
export type MobileWebTaskRepoSlugResult = z.infer<typeof MobileWebTaskRepoSlugResultSchema>
export type MobileWebTaskResumeUpdatePayload = z.infer<
  typeof MobileWebTaskResumeUpdatePayloadSchema
>
export type MobileWebTaskSettingsUpdatePayload = z.infer<
  typeof MobileWebTaskSettingsUpdatePayloadSchema
>
