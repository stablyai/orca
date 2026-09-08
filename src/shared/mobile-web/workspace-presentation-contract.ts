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

const MobileWebHostUpstreamSchema = z
  .object({
    owner: z.string().max(240),
    repo: z.string().max(240),
    host: z.string().max(240).optional()
  })
  .nullish()
  .catch(null)

/** How the page reads a raw `repo.list` answer. Unknown desktop fields are dropped rather than
 * rejected, and a row shape the page cannot use is skipped instead of failing the catalog. */
export const MobileWebHostRepositorySchema = z.object({
  id: MobileWebRepoIdSchema,
  displayName: z.string().min(1).max(240).catch('Repository'),
  path: z.string().max(4096).catch(''),
  badgeColor: z.string().max(64).optional().catch(undefined),
  repoIcon: MobileWebRepoIconSchema.nullish().catch(null),
  connectionId: z.string().max(512).nullish().catch(null),
  executionHostId: z.string().max(512).nullish().catch(null),
  kind: z.enum(['git', 'folder']).optional().catch(undefined),
  upstream: MobileWebHostUpstreamSchema,
  gitRemoteIdentity: z
    .object({
      host: z.string().max(240).optional(),
      owner: z.string().max(240).optional(),
      repo: z.string().max(240).optional()
    })
    .nullish()
    .catch(null)
})

export const MobileWebHostRepositoryListSchema = z.object({
  repos: z.array(z.unknown()).max(4 * MOBILE_WEB_REPOSITORY_LIMIT)
})

export type MobileWebHostRepository = z.infer<typeof MobileWebHostRepositorySchema>

const MobileWebWorkspaceStatusDefinitionSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    color: z.string().max(64).optional(),
    icon: z.string().max(80).optional()
  })
  .strict()

/** Read from a whole `ui.get` snapshot and written back through the merging `ui.set`, so it both
 * strips the UI keys the workspace list has no business seeing and drops a value it cannot use. */
export const MobileWebWorkspaceViewSettingsSchema = z.object({
  groupBy: z.enum(['none', 'workspace-status', 'repo', 'pr-status']).optional().catch(undefined),
  sortBy: z.enum(['name', 'smart', 'recent', 'repo', 'manual']).optional().catch(undefined),
  hideSleepingWorkspaces: z.boolean().optional().catch(undefined),
  hideDefaultBranchWorkspace: z.boolean().optional().catch(undefined),
  filterRepoIds: z
    .array(MobileWebRepoIdSchema)
    .max(MOBILE_WEB_REPOSITORY_LIMIT)
    .optional()
    .catch(undefined),
  collapsedGroups: z.array(z.string().max(512)).max(512).optional().catch(undefined),
  workspaceStatuses: z
    .array(MobileWebWorkspaceStatusDefinitionSchema)
    .max(MOBILE_WEB_WORKSPACE_STATUS_LIMIT)
    .optional()
    .catch(undefined)
})

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

export const MobileWebWorkspaceChangeSchema = z
  .object({
    type: z.enum(['ready', 'end', 'reposChanged', 'worktreesChanged', 'error'])
  })
  .strict()

export type MobileWebWorkspaceViewSettings = z.infer<typeof MobileWebWorkspaceViewSettingsSchema>
export type MobileWebWorkspaceUpdatePayload = z.infer<typeof MobileWebWorkspaceUpdatePayloadSchema>
export type MobileWebWorkspaceUpdateResult = z.infer<typeof MobileWebWorkspaceUpdateResultSchema>
export type MobileWebWorkspaceRemovePayload = z.infer<typeof MobileWebWorkspaceRemovePayloadSchema>
export type MobileWebWorkspaceRemoveResult = z.infer<typeof MobileWebWorkspaceRemoveResultSchema>
export type MobileWebWorkspaceChange = z.infer<typeof MobileWebWorkspaceChangeSchema>
