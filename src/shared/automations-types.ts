import type { SetupDecision, TuiAgent } from './types'
import type { TaskSourceContext, WorkspaceRunContext } from './task-source-context'

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'
export type AutomationExecutionTargetType = 'local' | 'ssh'
export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'
export type AutomationMissedRunPolicy = 'run_once_within_grace'
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

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
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

export type AutomationPrecheck = {
  command: string
  timeoutSeconds: number
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

export type Automation = {
  id: string
  name: string
  prompt: string
  precheck: AutomationPrecheck | null
  agentId: TuiAgent
  /** Why: runContext carries the logical project + host setup identity for
   *  multi-host projects; projectId remains only as the legacy repo-id storage
   *  field for pre-host-context automations.
   *  @deprecated Use runContext.projectId/runContext.repoId or
   *  getAutomationRunRepoId(). */
  runContext?: WorkspaceRunContext | null
  /** Why: task/provider data can come from a different host/account than the
   *  workspace run target, so automations persist it separately. */
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field. New code should persist
   *  runContext and use getAutomationRunRepoId() for fallback reads. */
  projectId: string
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  schedulerOwner: AutomationSchedulerOwner
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string | null
  baseBranch: string | null
  setupDecision?: SetupDecision
  reuseSession: boolean
  timezone: string
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunPolicy: AutomationMissedRunPolicy
  missedRunGraceMinutes: number
  createdAt: number
  updatedAt: number
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
  /** Why: run history must remain understandable after the backing workspace
   *  is deleted and its live metadata is gone. */
  workspaceDisplayName?: string | null
  sessionKind: 'terminal'
  chatSessionId: string | null
  terminalSessionId: string | null
  /** Why: a terminal tab can later point at a different pane/PTY. Automation
   *  run reopening must target the pane that actually executed the run. */
  terminalPaneKey: string | null
  terminalPtyId: string | null
  outputSnapshot: AutomationRunOutputSnapshot | null
  precheckResult: AutomationPrecheckResult | null
  usage: AutomationRunUsage | null
  error: string | null
  startedAt: number | null
  dispatchedAt: number | null
  createdAt: number
  /** Why: run titles must stay unique once retention prunes old runs, so the
   *  number can no longer be derived from how many runs are currently kept. */
  runNumber?: number
}

export type AutomationCreateInput = {
  name: string
  prompt: string
  precheck?: AutomationPrecheck | null
  agentId: TuiAgent
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field required for older stored
   *  automations and clients. Pair it with runContext for new writes. */
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
  setupDecision?: SetupDecision
  reuseSession?: boolean
  timezone: string
  rrule: string
  dtstart: number
  enabled?: boolean
  missedRunGraceMinutes?: number
}

export type AutomationUpdateInput = Partial<
  Pick<
    Automation,
    | 'name'
    | 'prompt'
    | 'precheck'
    | 'agentId'
    | 'runContext'
    | 'sourceContext'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
    | 'setupDecision'
    | 'reuseSession'
    | 'timezone'
    | 'rrule'
    | 'dtstart'
    | 'enabled'
    | 'missedRunGraceMinutes'
  >
>

export type AutomationDispatchRequest = {
  automation: Automation
  run: AutomationRun
  dispatchToken: string
}

export type AutomationDispatchResult = {
  runId: string
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
}

export type ExternalAutomationProvider = 'hermes' | 'openclaw'
export type ExternalAutomationManagerStatus = 'available' | 'unavailable'
export type ExternalAutomationAction = 'pause' | 'resume' | 'run' | 'delete'
export type ExternalAutomationRunStatus = 'completed' | 'failed' | 'unknown'

export type ExternalAutomationTarget =
  | {
      type: 'local'
    }
  | {
      type: 'ssh'
      connectionId: string
    }

export type ExternalAutomationJob = {
  id: string
  managerId: string
  provider: ExternalAutomationProvider
  name: string
  schedule: string
  rawSchedule: string | null
  enabled: boolean
  state: string
  prompt: string | null
  promptPreview: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  workdir: string | null
  runCount: number
  runs: ExternalAutomationRun[]
}

export type ExternalAutomationRun = {
  id: string
  managerId: string
  provider: ExternalAutomationProvider
  jobId: string
  runAt: string | null
  status: ExternalAutomationRunStatus
  outputPreview: string | null
  outputContent: string | null
  error: string | null
  outputPath: string | null
}

export type ExternalAutomationRunsPage = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  page: number
  pageSize: number
  total: number
  runs: ExternalAutomationRun[]
}

export type ExternalAutomationRunsInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  page: number
  pageSize: number
}

export type ExternalAutomationCreateInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  name: string
  prompt: string
  schedule: string
  workdir: string | null
}

export type ExternalAutomationUpdateInput = ExternalAutomationCreateInput & {
  jobId: string
}

export type ExternalAutomationManager = {
  id: string
  provider: ExternalAutomationProvider
  label: string
  targetLabel: string
  target: ExternalAutomationTarget
  status: ExternalAutomationManagerStatus
  error: string | null
  canManage: boolean
  jobs: ExternalAutomationJob[]
}

export type ExternalAutomationActionInput = {
  managerId: string
  provider: ExternalAutomationProvider
  target: ExternalAutomationTarget
  jobId: string
  action: ExternalAutomationAction
}
