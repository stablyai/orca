import { z } from 'zod'

export const MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT = 200
export const MOBILE_WEB_WORKSPACE_SNAPSHOT_MAX_BYTES = 120 * 1024
export const MOBILE_WEB_WORKSPACE_LIST_LIMIT = 10_000
export const MOBILE_WEB_WORKSPACE_CURSOR_MAX_LENGTH = 96

export const MobileWebWorkspaceIdSchema = z.string().min(1).max(512)

export const MobileWebWorkspaceSnapshotPayloadSchema = z
  .object({
    limit: z.number().int().min(1).max(MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT).default(100),
    cursor: z.string().min(1).max(MOBILE_WEB_WORKSPACE_CURSOR_MAX_LENGTH).optional()
  })
  .strict()

export const MobileWebWorkspaceAgentSchema = z
  .object({
    id: z.string().min(1).max(64),
    parentId: z.string().min(1).max(64).nullable(),
    state: z.enum(['working', 'blocked', 'waiting', 'done']),
    agentType: z.string().min(1).max(80).nullable(),
    prompt: z.string().max(512),
    taskTitle: z.string().max(240).nullable(),
    displayName: z.string().max(240).nullable(),
    lastAssistantMessage: z.string().max(512).nullable(),
    interrupted: z.boolean(),
    stateStartedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export const MobileWebWorkspaceSummarySchema = z
  .object({
    id: MobileWebWorkspaceIdSchema,
    repoId: z.string().min(1).max(512),
    workspaceKind: z.enum(['git', 'folder-workspace']),
    name: z.string().min(1).max(160),
    repo: z.string().min(1).max(240),
    branch: z.string().min(1).max(240),
    folderName: z.string().max(160),
    workspaceStatus: z.string().max(80),
    sortOrder: z.number().finite(),
    manualOrder: z.number().finite().nullable(),
    lastActivityAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    isArchived: z.boolean(),
    isMainWorktree: z.boolean(),
    hasHostSidebarActivity: z.boolean(),
    parentWorkspaceId: MobileWebWorkspaceIdSchema.nullable(),
    liveTerminalCount: z.number().int().nonnegative().max(10_000),
    hasAttachedPty: z.boolean(),
    unread: z.boolean(),
    lastOutputAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    isPinned: z.boolean(),
    isActive: z.boolean(),
    linkedPR: z
      .object({
        number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        state: z.string().min(1).max(80)
      })
      .strict()
      .nullable(),
    linkedIssue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    linkedLinearIssue: z.string().min(1).max(160).nullable(),
    linkedGitLabMR: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    linkedGitLabIssue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    comment: z.string().max(512),
    status: z.enum(['working', 'active', 'permission', 'done', 'inactive']),
    agents: z.array(MobileWebWorkspaceAgentSchema).max(16)
  })
  .strict()

export const MobileWebWorkspaceSnapshotResultSchema = z
  .object({
    workspaces: z.array(MobileWebWorkspaceSummarySchema).max(MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT),
    truncated: z.boolean(),
    nextCursor: z.string().min(1).max(MOBILE_WEB_WORKSPACE_CURSOR_MAX_LENGTH).nullable().optional()
  })
  .strict()

export const MobileWebWorkspaceActivationPayloadSchema = z
  .object({ workspaceId: MobileWebWorkspaceIdSchema })
  .strict()

export const MobileWebWorkspaceActivationResultSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    activated: z.literal(true),
    sleepingAgentWake: z.enum(['requested', 'unsupported-headless', 'not-applicable'])
  })
  .strict()

export type MobileWebWorkspaceAgent = z.infer<typeof MobileWebWorkspaceAgentSchema>
export type MobileWebWorkspaceSnapshotPayload = z.infer<
  typeof MobileWebWorkspaceSnapshotPayloadSchema
>
export type MobileWebWorkspaceSummary = z.infer<typeof MobileWebWorkspaceSummarySchema>
export type MobileWebWorkspaceSnapshotResult = z.infer<
  typeof MobileWebWorkspaceSnapshotResultSchema
>
export type MobileWebWorkspaceActivationPayload = z.infer<
  typeof MobileWebWorkspaceActivationPayloadSchema
>
export type MobileWebWorkspaceActivationResult = z.infer<
  typeof MobileWebWorkspaceActivationResultSchema
>
