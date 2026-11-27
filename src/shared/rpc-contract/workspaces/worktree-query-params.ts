import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { normalizeExecutionHostId } from '../../execution-host/execution-host'
import { CLIENT_PROVENANCE_SNAPSHOT_MAX } from '../../automations/ownership/automation-workspace-provenance'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { OptionalBoolean, OptionalFiniteNumber, OptionalString } from '../rpc-param-primitives'
import { RUNTIME_NAVIGATION_TARGETS } from '../../remote-runtime/session-graph/runtime-navigation'
import type { WorkspaceLinkedItemSchema } from '../../workspace-attachments/workspace-linked-item-schema'
import type { TaskSourceContextSchema } from '../../work-items/task-source-context-schema'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../workspace-attachments/workspace-linked-item-source-context'

export const OptionalExecutionHostId = lazyZodSchema(() =>
  z
    .string()
    .transform((value, ctx) => {
      const hostId = normalizeExecutionHostId(value)
      if (!hostId) {
        ctx.addIssue({ code: 'custom', message: 'Invalid host id' })
        return z.NEVER
      }
      return hostId
    })
    .optional()
)

export const OptionalTuiAgent = lazyZodSchema(() =>
  z
    .unknown()
    .superRefine((value, ctx) => {
      if (value !== undefined && !isTuiAgent(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
      }
    })
    .transform((value): TuiAgent | undefined => (isTuiAgent(value) ? value : undefined))
    .optional()
)

export const AutomationWorkspaceProvenanceRequest = lazyZodSchema(() =>
  z.object({
    automationId: z.string(),
    automationRunId: z.string(),
    dispatchToken: z.string(),
    createRequestId: z.string()
  })
)

// A label for another owner's run: the host records it only for automations it does not hold, and stamps createdAt.
const ProvenanceId = lazyZodSchema(() => z.string().min(1).max(256))
const ProvenanceSnapshot = lazyZodSchema(() => z.string().max(CLIENT_PROVENANCE_SNAPSHOT_MAX))

export const ClientAutomationWorkspaceProvenance = lazyZodSchema(() =>
  z.object({
    automationId: ProvenanceId,
    automationNameSnapshot: ProvenanceSnapshot,
    automationRunId: ProvenanceId,
    automationRunTitleSnapshot: ProvenanceSnapshot,
    executionTargetType: z.enum(['local', 'ssh']),
    executionTargetId: z.string().max(256),
    projectId: z.string().max(256),
    repoId: z.string().max(256).optional(),
    hostId: OptionalExecutionHostId
  })
)

// Descriptive provenance grants no authority; the host stamps createdAt to avoid client-clock sort skew.
export const CliWorkspaceProvenanceRequest = lazyZodSchema(() =>
  z.object({
    callerTerminalHandle: OptionalString
  })
)

export const WorktreeListParams = lazyZodSchema(() =>
  z.object({
    repo: OptionalString,
    limit: OptionalFiniteNumber
  })
)

export const WorktreeDetectedListParams = lazyZodSchema(() =>
  z.object({
    repo: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing repo selector'))
  })
)

export const WorktreeTeardownMissingTerminalsParams = lazyZodSchema(() =>
  WorktreeDetectedListParams.extend({
    worktreeIds: z.array(z.string().min(1)).max(10_000),
    connectionId: z.string().nullable().optional()
  })
)

export const WorktreePsParams = lazyZodSchema(() =>
  z.object({
    limit: OptionalFiniteNumber,
    afterSnapshotId: z.string().min(1).max(128).nullable().optional(),
    // Opt-in: the caller holds afterSnapshotId's rows and can rebuild a catalog from rowsFromBase; older hosts ignore it.
    acceptRowDelta: z.literal(true).optional(),
    supportsWorktreeVisibilitySourceDefaults: z.literal(true).optional(),
    // Opt-in: wait lookups read screens and probe PTYs, too costly for pollers; older hosts omit agentWait.
    includeAgentWait: z.literal(true).optional()
  })
)

export const WorktreeSortOrder = lazyZodSchema(() =>
  z.object({
    orderedIds: z.array(z.string()),
    // Parallel to orderedIds: the copy each id names, so a same-id twin keeps its own order.
    hostIds: z.array(z.string()).optional()
  })
)

export const WorktreeSelector = lazyZodSchema(() =>
  z.object({
    worktree: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing worktree selector'))
  })
)

/** Opt-in: path: and name: also match folder workspaces. Absent keeps older clients' repo-only meaning. */
export const MatchFolderWorkspaces = lazyZodSchema(() => z.literal(true).optional())

export const WorktreeShow = lazyZodSchema(() =>
  WorktreeSelector.extend({
    matchFolderWorkspaces: MatchFolderWorkspaces
  })
)

export const WorktreeRunApprovedSetup = lazyZodSchema(() =>
  WorktreeSelector.extend({
    approvedSetupHash: z.string().min(1).max(128)
  })
)

// Why optional: an older host strips the unknown field and marks its chats asleep as before.
export const WorktreeSleepParams = lazyZodSchema(() =>
  WorktreeSelector.extend({
    markChatsAsleep: z.boolean().optional()
  })
)

/** The host's own workspace id (its local key), as its sidebar row carries it. */
export const WorktreeAutoNameParams = lazyZodSchema(() =>
  z.object({
    worktreeId: z.string().min(1, 'Missing worktree id')
  })
)

/** Waits on one running attempt, so a client without the host's attempt events still sees it finish. */
export const WorktreeAutoNameWaitParams = lazyZodSchema(() =>
  WorktreeAutoNameParams.extend({
    attemptId: z.number().int().nonnegative()
  })
)

export const WorktreeActivate = lazyZodSchema(() =>
  WorktreeSelector.extend({
    notifyClients: OptionalBoolean,
    navigation: z.enum(RUNTIME_NAVIGATION_TARGETS).optional()
  })
)

/** Shared by WorktreeCreate and WorktreeSet so the two error messages cannot drift. */
export function assertLinkedWorkItemSourceContextMatch(
  params: {
    linkedWorkItem?: z.infer<typeof WorkspaceLinkedItemSchema> | null
    linkedTaskSourceContext?: z.infer<typeof TaskSourceContextSchema> | null
  },
  ctx: z.RefinementCtx
): void {
  if (
    params.linkedWorkItem &&
    params.linkedTaskSourceContext &&
    !isWorkspaceLinkedItemSourceContextMatch(params.linkedWorkItem, params.linkedTaskSourceContext)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Linked work item and source context identities must match'
    })
  }
}

/** A create's caller context, resolved by the caller's own Orca as its same-machine create would. */
export const WorktreeResolveCallerParent = lazyZodSchema(() =>
  z.object({
    envParentWorkspace: OptionalString,
    callerTerminalHandle: OptionalString,
    cwdParentWorktree: OptionalString,
    cwdParentAmbiguous: z.literal(true).optional(),
    /** The workspace note; a task id in it names its parent as on a same-machine create. */
    comment: OptionalString
  })
)
