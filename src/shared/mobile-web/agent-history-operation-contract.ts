import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT = 64
export const MOBILE_WEB_AGENT_HISTORY_PREVIEW_LIMIT = 5
export const MOBILE_WEB_AGENT_HISTORY_QUERY_MAX_LENGTH = 256
export const MOBILE_WEB_AGENT_HISTORY_SESSION_ID_MAX_LENGTH = 512
export const MOBILE_WEB_AGENT_HISTORY_AGENTS = [
  'claude',
  'codex',
  'hermes',
  'pi',
  'omp',
  'prime-agent',
  'cursor',
  'gemini',
  'antigravity',
  'rovo',
  'copilot',
  'opencode',
  'grok',
  'openclaw',
  'devin',
  'droid',
  'cline',
  'kimi'
] as const

const AgentHistoryLabelSchema = z.string().max(240)

/** A session is named by the provider id and agent the scanner already reports, so nothing
 * host-shaped (transcript path, cwd) has to cross to the page and no handle has to be kept. */
export const MobileWebAgentHistorySessionRefSchema = z
  .object({
    agent: z.enum(MOBILE_WEB_AGENT_HISTORY_AGENTS),
    sessionId: z.string().min(1).max(MOBILE_WEB_AGENT_HISTORY_SESSION_ID_MAX_LENGTH)
  })
  .strict()

export const MobileWebAgentHistorySnapshotPayloadSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    scope: z.enum(['workspace', 'project', 'all']),
    query: z.string().max(MOBILE_WEB_AGENT_HISTORY_QUERY_MAX_LENGTH),
    force: z.boolean(),
    offset: z.number().int().nonnegative().max(100_000).optional()
  })
  .strict()

export const MobileWebAgentHistorySessionSchema = z
  .object({
    sessionId: z.string().min(1).max(MOBILE_WEB_AGENT_HISTORY_SESSION_ID_MAX_LENGTH),
    agent: z.enum(MOBILE_WEB_AGENT_HISTORY_AGENTS),
    agentLabel: z.string().min(1).max(80),
    title: z.string().max(512),
    lastMessage: z.string().max(2_048),
    messageCount: z.number().int().nonnegative().max(1_000_000),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    groupKey: z.string().min(1).max(160),
    groupLabel: AgentHistoryLabelSchema,
    isCurrentWorkspace: z.boolean(),
    resumeAvailable: z.boolean()
  })
  .strict()

export const MobileWebAgentHistorySnapshotResultSchema = z
  .object({
    supported: z.boolean(),
    sessions: z.array(MobileWebAgentHistorySessionSchema).max(MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT),
    skippedTranscriptCount: z.number().int().nonnegative().max(10_000),
    nextOffset: z.number().int().nonnegative().max(100_000).nullable()
  })
  .strict()

/** The lookup rescans the same scope the row was listed under, so it never has to widen past it. */
const MobileWebAgentHistorySessionTargetSchema = MobileWebAgentHistorySessionRefSchema.extend({
  workspaceId: MobileWebWorkspaceIdSchema,
  scope: z.enum(['workspace', 'project', 'all'])
})

export const MobileWebAgentHistoryPreviewPayloadSchema = MobileWebAgentHistorySessionTargetSchema

export const MobileWebAgentHistoryPreviewResultSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'system', 'tool', 'unknown']),
            text: z.string().max(4_096)
          })
          .strict()
      )
      .max(MOBILE_WEB_AGENT_HISTORY_PREVIEW_LIMIT)
  })
  .strict()

export const MobileWebAgentHistoryResumePayloadSchema = MobileWebAgentHistorySessionTargetSchema

export const MobileWebAgentHistoryResumeResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('queued'),
      /* The page can only route to a workspace it already holds a handle for, so it needs to be
       * told whether the resume landed here. The host worktree id rides along so routing can be
       * added later without another wire change. */
      targetIsCurrentWorkspace: z.boolean(),
      targetWorktreeId: z.string().min(1).max(1024),
      targetWorkspaceName: z.string().max(240)
    })
    .strict(),
  z.object({ status: z.literal('blocked'), message: z.string().min(1).max(512) }).strict()
])

export type MobileWebAgentHistorySnapshotPayload = z.infer<
  typeof MobileWebAgentHistorySnapshotPayloadSchema
>
export type MobileWebAgentHistorySession = z.infer<typeof MobileWebAgentHistorySessionSchema>
export type MobileWebAgentHistorySnapshotResult = z.infer<
  typeof MobileWebAgentHistorySnapshotResultSchema
>
export type MobileWebAgentHistoryPreviewResult = z.infer<
  typeof MobileWebAgentHistoryPreviewResultSchema
>
export type MobileWebAgentHistorySessionRef = z.infer<typeof MobileWebAgentHistorySessionRefSchema>
export type MobileWebAgentHistoryPreviewPayload = z.infer<
  typeof MobileWebAgentHistoryPreviewPayloadSchema
>
export type MobileWebAgentHistoryResumePayload = z.infer<
  typeof MobileWebAgentHistoryResumePayloadSchema
>
export type MobileWebAgentHistoryResumeResult = z.infer<
  typeof MobileWebAgentHistoryResumeResultSchema
>
