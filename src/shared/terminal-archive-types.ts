import { z } from 'zod'
import {
  normalizeAgentProviderSession,
  RESUMABLE_TUI_AGENTS,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent, WorkspaceSessionState } from './types'

export const TERMINAL_ARCHIVE_SCHEMA_VERSION = 1 as const
export const DEFAULT_TERMINAL_ARCHIVE_RETENTION_DAYS = 7
export const MIN_TERMINAL_ARCHIVE_RETENTION_DAYS = 1
export const MAX_TERMINAL_ARCHIVE_RETENTION_DAYS = 365

export const TERMINAL_ARCHIVE_REASONS = [
  'user-close',
  'relay-worker-lost',
  'daemon-worker-lost'
] as const

export type TerminalArchiveReason = (typeof TERMINAL_ARCHIVE_REASONS)[number]

export const TERMINAL_ARCHIVE_CLOSE_EXCLUSIONS = [
  'cleanup',
  'pty-exit',
  'app-shutdown',
  'hibernation',
  'pane-close'
] as const

export type TerminalArchiveCloseExclusion = (typeof TERMINAL_ARCHIVE_CLOSE_EXCLUSIONS)[number]
export type TerminalArchiveCloseReason = TerminalArchiveReason | TerminalArchiveCloseExclusion

export const TERMINAL_ARCHIVE_SNAPSHOT_SOURCES = [
  'renderer',
  'daemon-headless',
  'relay-tail',
  'session-sidecar'
] as const

export type TerminalArchiveSnapshotSourceName = (typeof TERMINAL_ARCHIVE_SNAPSHOT_SOURCES)[number]

export const TERMINAL_ARCHIVE_HINT_SOURCES = [
  'spawn',
  'launch',
  'hook',
  'sleeping-session'
] as const

export type TerminalArchiveHintSource = (typeof TERMINAL_ARCHIVE_HINT_SOURCES)[number]

export const TERMINAL_ARCHIVE_HINT_FIELDS = [
  'cwd',
  'startupCommand',
  'shellOverride',
  'launchAgent',
  'providerSession',
  'orchestrationTaskId'
] as const

export type TerminalArchiveHintField = (typeof TERMINAL_ARCHIVE_HINT_FIELDS)[number]

const executionHostIdSchema = z
  .string()
  .transform((value, ctx) => {
    const hostId = normalizeExecutionHostId(value)
    if (!hostId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid execution host id' })
      return z.NEVER
    }
    return hostId
  })
  .pipe(z.custom<ExecutionHostId>())

const agentProviderSessionSchema = z
  .object({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string().min(1).max(512),
    transcriptPath: z.string().min(1).optional()
  })
  .strict()
  .transform((raw, ctx) => {
    const normalized = normalizeAgentProviderSession(raw)
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid provider session' })
      return z.NEVER
    }
    return normalized
  })

const resumableAgentSchema = z.enum(RESUMABLE_TUI_AGENTS)

const archiveLayoutNodeSchema = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), leafId: z.string().min(1) }).strict(),
    z
      .object({
        type: z.literal('split'),
        direction: z.enum(['vertical', 'horizontal']),
        first: archiveLayoutNodeSchema,
        second: archiveLayoutNodeSchema,
        ratio: z.number().finite().min(0).max(1).optional()
      })
      .strict()
  ])
)

export const archivedTerminalLayoutSchema = z
  .object({
    root: archiveLayoutNodeSchema.nullable(),
    activeLeafId: z.string().min(1).nullable(),
    expandedLeafId: z.string().min(1).nullable(),
    titlesByLeafId: z.record(z.string().min(1), z.string()).optional()
  })
  .strict()

export type ArchivedTerminalLayout = z.infer<typeof archivedTerminalLayoutSchema>

export const terminalArchiveSnapshotSchema = z
  .object({
    ref: z.string().regex(/^v1a-[0-9a-f]{32}$/),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    source: z.enum(TERMINAL_ARCHIVE_SNAPSHOT_SOURCES)
  })
  .strict()

export type TerminalArchiveSnapshot = z.infer<typeof terminalArchiveSnapshotSchema>

/** Renderer-owned xterm bytes captured before a user closes an entire tab. */
export type TerminalArchiveRendererSnapshot = {
  buffer: string
  source: 'renderer'
  truncated: boolean
  byteLength: number
}

/** Narrow renderer → main handoff; main supplies the authoritative pane identities. */
export type TerminalArchiveRendererCloseRequest = {
  session: WorkspaceSessionState
  worktreeId: string
  tabId: string
  executionHostId: ExecutionHostId
  runtimeEnvironmentId?: string
  snapshotsByLeafId: Record<string, TerminalArchiveRendererSnapshot>
}

export const archivedTerminalPaneSchema = z
  .object({
    archivedLeafId: z.string().min(1),
    cwd: z.string(),
    shellOverride: z.string().min(1).optional(),
    startupCommand: z.string().min(1).optional(),
    startedAt: z.number().finite().nonnegative().optional(),
    snapshot: terminalArchiveSnapshotSchema.optional(),
    agent: z
      .object({
        type: resumableAgentSchema,
        providerSession: agentProviderSessionSchema
      })
      .strict()
      .optional(),
    orchestrationTaskId: z.string().min(1).max(512).optional()
  })
  .strict()

export type ArchivedTerminalPane = Omit<z.infer<typeof archivedTerminalPaneSchema>, 'agent'> & {
  agent?: { type: ResumableTuiAgent; providerSession: AgentProviderSessionMetadata }
}

export const archivedTerminalTabSchema = z
  .object({
    schemaVersion: z.literal(TERMINAL_ARCHIVE_SCHEMA_VERSION),
    id: z.string().uuid(),
    operationId: z.string().min(1).max(512),
    sourceTabId: z.string().min(1),
    sourcePaneSignature: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    executionHostId: executionHostIdSchema,
    runtimeEnvironmentId: z.string().min(1).optional(),
    worktreeId: z.string().min(1),
    title: z.string(),
    defaultTitle: z.string().optional(),
    color: z.string().nullable().optional(),
    layout: archivedTerminalLayoutSchema,
    panesByLeafId: z.record(z.string().min(1), archivedTerminalPaneSchema),
    reason: z.enum(TERMINAL_ARCHIVE_REASONS),
    createdAt: z.number().finite().nonnegative().optional(),
    capturedAt: z.number().finite().nonnegative().optional(),
    archivedAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative(),
    lastRestoredAt: z.number().finite().nonnegative().optional(),
    restoreCount: z.number().int().nonnegative()
  })
  .strict()

export type ArchivedTerminalTab = Omit<
  z.infer<typeof archivedTerminalTabSchema>,
  'executionHostId' | 'panesByLeafId'
> & {
  executionHostId: ExecutionHostId
  panesByLeafId: Record<string, ArchivedTerminalPane>
}

export const terminalArchivesByIdSchema = z.record(z.string().uuid(), archivedTerminalTabSchema)

export const terminalArchiveHintSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    startupCommand: z.string().min(1).optional(),
    shellOverride: z.string().min(1).optional(),
    launchAgent: z.custom<TuiAgent>(isTuiAgent).optional(),
    providerSession: agentProviderSessionSchema.optional(),
    orchestrationTaskId: z.string().min(1).max(512).optional(),
    startedAt: z.number().finite().nonnegative().optional(),
    fieldSources: z
      .object({
        cwd: z.enum(TERMINAL_ARCHIVE_HINT_SOURCES).optional(),
        startupCommand: z.enum(TERMINAL_ARCHIVE_HINT_SOURCES).optional(),
        shellOverride: z.enum(TERMINAL_ARCHIVE_HINT_SOURCES).optional(),
        launchAgent: z.enum(TERMINAL_ARCHIVE_HINT_SOURCES).optional(),
        providerSession: z.enum(TERMINAL_ARCHIVE_HINT_SOURCES).optional(),
        orchestrationTaskId: z.enum(TERMINAL_ARCHIVE_HINT_SOURCES).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export type TerminalArchiveHint = Omit<
  z.infer<typeof terminalArchiveHintSchema>,
  'providerSession'
> & {
  providerSession?: AgentProviderSessionMetadata
}

export const terminalArchiveHintsByPaneKeySchema = z.record(
  z.string().min(1),
  terminalArchiveHintSchema
)

export type ArchivedTerminalTabSummary = {
  id: string
  operationId: string
  executionHostId: ExecutionHostId
  worktreeId: string
  title: string
  archivedAt: number
  expiresAt: number
  reason: TerminalArchiveReason
  restoreCount: number
  worktreeMissing?: boolean
}

export const TERMINAL_ARCHIVE_ERROR_CODES = [
  'archive_not_found',
  'archive_expired',
  'archive_host_unreachable',
  'archive_worktree_missing',
  'archive_host_mismatch',
  'not_implemented'
] as const

export type TerminalArchiveErrorCode = (typeof TERMINAL_ARCHIVE_ERROR_CODES)[number]

export type RestoreTerminalArchiveResult = {
  ok: false
  code: TerminalArchiveErrorCode
  archiveId: string
}

export function normalizeTerminalArchiveRetentionDays(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric)) {
    return DEFAULT_TERMINAL_ARCHIVE_RETENTION_DAYS
  }
  return Math.min(
    MAX_TERMINAL_ARCHIVE_RETENTION_DAYS,
    Math.max(MIN_TERMINAL_ARCHIVE_RETENTION_DAYS, Math.round(numeric))
  )
}

export function toArchivedTerminalTabSummary(
  archive: ArchivedTerminalTab,
  options: { worktreeMissing?: boolean } = {}
): ArchivedTerminalTabSummary {
  return {
    id: archive.id,
    operationId: archive.operationId,
    executionHostId: archive.executionHostId,
    worktreeId: archive.worktreeId,
    title: archive.title,
    archivedAt: archive.archivedAt,
    expiresAt: archive.expiresAt,
    reason: archive.reason,
    restoreCount: archive.restoreCount,
    ...(options.worktreeMissing ? { worktreeMissing: true } : {})
  }
}
