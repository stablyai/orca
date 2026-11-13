import type { SetupTrustMismatch } from '../../worktree/create-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../work-items/task-source-context'

export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'completed'
  | 'skipped_precheck'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'

export type AutomationRunTrigger = 'scheduled' | 'manual'

/** Statuses a run can never leave; only these are safe to evict from history. */
export function isFinalAutomationRunStatus(status: AutomationRunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'dispatch_failed' ||
    status === 'skipped_precheck' ||
    status === 'skipped_missed' ||
    status === 'skipped_unavailable' ||
    status === 'skipped_needs_interactive_auth'
  )
}

/** Folded runs keep their first occurrence's timestamps, so the latest occurrence is when it last ran. */
export function getAutomationRunLastRunAt(
  run: Pick<
    AutomationRun,
    'dispatchedAt' | 'startedAt' | 'createdAt' | 'occurrenceCount' | 'lastOccurrenceAt'
  >
): number {
  const at = run.dispatchedAt ?? run.startedAt ?? run.createdAt
  return (run.occurrenceCount ?? 1) > 1 && run.lastOccurrenceAt && run.lastOccurrenceAt > at
    ? run.lastOccurrenceAt
    : at
}

export type AutomationRunUsageProvider = 'claude' | 'codex'

export type AutomationRunUsageStatus = 'known' | 'unavailable'

export type AutomationRunUsageAttribution = 'provider_session_time_window'

export type AutomationRunUsageUnavailableReason =
  | 'run_not_finished'
  | 'provider_unsupported'
  | 'remote_usage_unavailable'
  | 'usage_not_enabled'
  | 'scan_failed'
  | 'no_matching_session'
  | 'ambiguous_session'

export type AutomationRunUsage = {
  status: AutomationRunUsageStatus
  provider: AutomationRunUsageProvider | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
  estimatedCostSource: 'api_equivalent' | null
  providerSessionId: string | null
  attribution: AutomationRunUsageAttribution | null
  collectedAt: number
  unavailableReason: AutomationRunUsageUnavailableReason | null
  unavailableMessage: string | null
}

export type AutomationRunOutputSnapshot = {
  format: 'plain_text'
  content: string
  capturedAt: number
  truncated: boolean
}

export type AutomationPrecheckResult = {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

export type AutomationRun = {
  id: string
  automationId: string
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
  title: string
  scheduledFor: number
  status: AutomationRunStatus
  trigger: AutomationRunTrigger
  workspaceId: string | null
  /** Keep run history understandable after workspace deletion removes live metadata. */
  workspaceDisplayName?: string | null
  sessionKind: 'terminal' | 'chat'
  chatSessionId: string | null
  terminalSessionId: string | null
  /** Retain the executed pane/PTY because terminal tabs may later point elsewhere. */
  terminalPaneKey: string | null
  terminalPtyId: string | null
  outputSnapshot: AutomationRunOutputSnapshot | null
  precheckResult: AutomationPrecheckResult | null
  usage: AutomationRunUsage | null
  error: string | null
  /** Localizes `error`; old records omit it and clients show `error` as stored. */
  errorCode?: string
  errorParams?: Record<string, string | number>
  startedAt: number | null
  dispatchedAt: number | null
  createdAt: number
  /** Persist unique run numbers; retention makes retained count unsuitable. */
  runNumber?: number
  /** Fold consecutive identical target refusals instead of recording each occurrence; absence counts as one. */
  occurrenceCount?: number
  /** `scheduledFor` of the most recently folded occurrence; absent until one folds. */
  lastOccurrenceAt?: number
  /** Setup was skipped: the new workspace's branch has different setup than the automation approved. */
  setupSkippedReason?: AutomationRunSetupSkippedReason
  /** The skipped setup content, so it can be reviewed and approved for later runs. Older hosts omit it. */
  setupSkippedContent?: SetupTrustMismatch
}

export type AutomationRunSetupSkippedReason = 'setup-changed'

/** A bounded history response; older hosts may continue returning `runs` only. */
export type AutomationRunsPage = {
  runs: AutomationRun[]
  nextCursor: string | null
}

export type AutomationDispatchResult = {
  runId: string
  sessionKind?: 'terminal' | 'chat'
  chatSessionId?: string | null
  status: AutomationRunStatus
  workspaceId?: string | null
  workspaceDisplayName?: string | null
  terminalSessionId?: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  outputSnapshot?: AutomationRunOutputSnapshot | null
  precheckResult?: AutomationPrecheckResult | null
  usage?: AutomationRunUsage | null
  error?: string | null
  errorCode?: string | null
  errorParams?: Record<string, string | number> | null
  /** With `dispatched`: when the agent was handed the run, if not now. */
  dispatchedAt?: number
  setupSkippedReason?: AutomationRunSetupSkippedReason
  setupSkippedContent?: SetupTrustMismatch
}
