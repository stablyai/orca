import type { TuiAgent } from './types'

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'
export type AutomationExecutionTargetType = 'local' | 'ssh'
export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'
export type AutomationMissedRunPolicy = 'run_once_within_grace'
export type AutomationRunStatus =
  | 'pending'
  | 'dispatching'
  | 'dispatched'
  | 'completed'
  | 'skipped_missed'
  | 'skipped_unavailable'
  | 'skipped_needs_interactive_auth'
  | 'dispatch_failed'
export type AutomationRunTrigger = 'scheduled' | 'manual'

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

export type Automation = {
  id: string
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  schedulerOwner: AutomationSchedulerOwner
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string | null
  baseBranch: string | null
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
  title: string
  scheduledFor: number
  status: AutomationRunStatus
  trigger: AutomationRunTrigger
  workspaceId: string | null
  sessionKind: 'terminal'
  chatSessionId: string | null
  terminalSessionId: string | null
  usage: AutomationRunUsage | null
  error: string | null
  startedAt: number | null
  dispatchedAt: number | null
  createdAt: number
}

export type AutomationCreateInput = {
  name: string
  prompt: string
  agentId: TuiAgent
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
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
    | 'agentId'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
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
}

export type AutomationDispatchResult = {
  runId: string
  status: AutomationRunStatus
  workspaceId?: string | null
  terminalSessionId?: string | null
  usage?: AutomationRunUsage | null
  error?: string | null
}

export type ExternalAutomationProvider = 'hermes' | 'openclaw'
export type ExternalAutomationManagerStatus = 'available' | 'unavailable'
export type ExternalAutomationAction = 'pause' | 'resume' | 'run' | 'delete'

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
  enabled: boolean
  state: string
  promptPreview: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  workdir: string | null
}

export type ExternalAutomationManager = {
  id: string
  provider: ExternalAutomationProvider
  label: string
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
