import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { SetupDecision } from '../worktree/create-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../work-items/task-source-context'
import type {
  AutomationLaunchSetup,
  AutomationLaunchSetupPatch,
  AutomationLaunchPreferences
} from './launch/automation-launch-types'

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'

export type AutomationExecutionTargetType = 'local' | 'ssh'

export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'

export type AutomationMissedRunPolicy = 'run_once_within_grace'

/** What a reuse-session run does when its workspace still holds a session it cannot reuse. */
export type AutomationOnNoReusableSession = 'skip'

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export type AutomationPrecheck = {
  command: string
  timeoutSeconds: number
}

export type Automation = {
  id: string
  /** Optional client request key used to make cross-authority creates retry-safe. */
  creationKey?: string
  name: string
  prompt: string
  precheck: AutomationPrecheck | null
  agentId: TuiAgent
  surface?: 'chat' | 'terminal'
  launchSetup?: AutomationLaunchSetup
  launchPreferences?: AutomationLaunchPreferences
  agentArgs?: string | null
  /** Saved text appended to the host's default agent Arguments on each fresh run; absent means none. */
  extraAgentArgs?: string
  /** Why: runContext carries the logical project + host setup identity for
   *  multi-host projects; projectId remains only as the legacy repo-id storage
   *  field for pre-host-context automations.
   *  @deprecated Use runContext.projectId/runContext.repoId or
   *  getAutomationRunRepoId(). */
  runContext?: WorkspaceRunContext | null
  /** Task/provider host/account may differ from the workspace run target; persist independently. */
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field. New code should persist
   *  runContext and use getAutomationRunRepoId() for fallback reads. */
  projectId: string
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  /** Pin SSH registration identity to prevent same-ID re-adoption after removal. Absent on local/legacy/gone-target orphans. */
  executionTargetGeneration?: number
  schedulerOwner: AutomationSchedulerOwner
  workspaceMode: AutomationWorkspaceMode
  workspaceId: string | null
  baseBranch: string | null
  setupDecision?: SetupDecision
  /** Hash of the setup content approved with `run`; a run whose branch content differs skips setup. Older automations omit it. */
  setupTrustHash?: string
  reuseSession: boolean
  /** Skip instead of starting a second session while the previous one is live but cannot take the run. */
  onNoReusableSession?: AutomationOnNoReusableSession
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

export type AutomationCreateInput = {
  /** Optional idempotency key; repeated creates return the original record. */
  creationKey?: string
  name: string
  prompt: string
  precheck?: AutomationPrecheck | null
  agentId: TuiAgent
  launchSetupPatch?: AutomationLaunchSetupPatch
  /** Empty or whitespace means no extras. */
  extraAgentArgs?: string
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field required for older stored
   *  automations and clients. Pair it with runContext for new writes. */
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
  setupDecision?: SetupDecision
  setupTrustHash?: string
  reuseSession?: boolean
  onNoReusableSession?: AutomationOnNoReusableSession
  timezone: string
  rrule: string
  dtstart: number
  enabled?: boolean
  missedRunGraceMinutes?: number
}

export type AutomationUpdateInput = { launchSetupPatch?: AutomationLaunchSetupPatch } & Partial<
  Pick<
    Automation,
    | 'name'
    | 'prompt'
    | 'precheck'
    | 'agentId'
    | 'extraAgentArgs'
    | 'runContext'
    | 'sourceContext'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
    | 'setupDecision'
    | 'setupTrustHash'
    | 'reuseSession'
    | 'onNoReusableSession'
    | 'timezone'
    | 'rrule'
    | 'dtstart'
    | 'enabled'
    | 'missedRunGraceMinutes'
  >
>
