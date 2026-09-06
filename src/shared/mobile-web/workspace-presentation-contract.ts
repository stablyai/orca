import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_REPOSITORY_LIMIT = 200
export const MOBILE_WEB_WORKSPACE_STATUS_LIMIT = 64

export const MobileWebRepoIdSchema = z.string().min(1).max(512)

const MobileWebRepoIconSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lucide'), name: z.string().min(1).max(40) }).strict(),
  z.object({ type: z.literal('emoji'), emoji: z.string().min(1).max(16) }).strict(),
  z
    .object({
      type: z.literal('image'),
      src: z.string().min(1).max(8192),
      source: z.enum(['upload', 'file', 'favicon', 'github']),
      label: z.string().min(1).max(80).optional()
    })
    .strict()
])

export const MobileWebRepositoryPresentationSchema = z
  .object({
    id: MobileWebRepoIdSchema,
    displayName: z.string().min(1).max(240),
    badgeColor: z.string().max(64).optional(),
    repoIcon: MobileWebRepoIconSchema.nullable().optional()
  })
  .strict()

export const MobileWebWorkspaceRepositoriesPayloadSchema = z.object({}).strict()

export const MobileWebWorkspaceRepositoriesResultSchema = z
  .object({
    repositories: z.array(MobileWebRepositoryPresentationSchema).max(MOBILE_WEB_REPOSITORY_LIMIT),
    truncated: z.boolean()
  })
  .strict()

const MobileWebWorkspaceStatusDefinitionSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    color: z.string().max(64).optional(),
    icon: z.string().max(80).optional()
  })
  .strict()

export const MobileWebWorkspaceViewSettingsSchema = z
  .object({
    groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional(),
    sortBy: z.enum(['name', 'smart', 'recent', 'repo', 'manual']).optional(),
    hideSleepingWorkspaces: z.boolean().optional(),
    hideDefaultBranchWorkspace: z.boolean().optional(),
    filterRepoIds: z.array(MobileWebRepoIdSchema).max(MOBILE_WEB_REPOSITORY_LIMIT).optional(),
    collapsedGroups: z.array(z.string().max(512)).max(512).optional(),
    workspaceStatuses: z
      .array(MobileWebWorkspaceStatusDefinitionSchema)
      .max(MOBILE_WEB_WORKSPACE_STATUS_LIMIT)
      .optional()
  })
  .strict()

export const MobileWebWorkspaceSettingsSnapshotPayloadSchema = z.object({}).strict()
export const MobileWebWorkspaceSettingsSnapshotResultSchema = z
  .object({ settings: MobileWebWorkspaceViewSettingsSchema.nullable() })
  .strict()
export const MobileWebWorkspaceSettingsUpdatePayloadSchema = MobileWebWorkspaceViewSettingsSchema
export const MobileWebWorkspaceSettingsUpdateResultSchema = z.null()

export const MobileWebWorkspaceUpdatePayloadSchema = z.discriminatedUnion('mutation', [
  z
    .object({
      mutation: z.literal('pin'),
      workspaceId: MobileWebWorkspaceIdSchema,
      pinned: z.boolean()
    })
    .strict(),
  z
    .object({
      mutation: z.literal('sleep'),
      workspaceId: MobileWebWorkspaceIdSchema
    })
    .strict()
])

export const MobileWebWorkspaceUpdateResultSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema, updated: z.literal(true) })
  .strict()

export const MobileWebWorkspaceRemovePayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()
export const MobileWebWorkspaceRemoveResultSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema, removed: z.literal(true) })
  .strict()

export const MobileWebWorkspaceSubscribePayloadSchema = z.object({}).strict()
export const MobileWebWorkspaceChangeSchema = z
  .object({
    type: z.enum(['ready', 'end', 'reposChanged', 'worktreesChanged', 'error'])
  })
  .strict()

export type MobileWebWorkspaceRepositoriesResult = z.infer<
  typeof MobileWebWorkspaceRepositoriesResultSchema
>
export type MobileWebWorkspaceViewSettings = z.infer<typeof MobileWebWorkspaceViewSettingsSchema>
export type MobileWebWorkspaceUpdatePayload = z.infer<typeof MobileWebWorkspaceUpdatePayloadSchema>
export type MobileWebWorkspaceUpdateResult = z.infer<typeof MobileWebWorkspaceUpdateResultSchema>
export type MobileWebWorkspaceRemovePayload = z.infer<typeof MobileWebWorkspaceRemovePayloadSchema>
export type MobileWebWorkspaceRemoveResult = z.infer<typeof MobileWebWorkspaceRemoveResultSchema>
export type MobileWebWorkspaceChange = z.infer<typeof MobileWebWorkspaceChangeSchema>
