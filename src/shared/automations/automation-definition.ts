import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { SetupDecision } from '../worktree/create-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../work-items/task-source-context'
import type {
  AutomationLaunchSetup,
  AutomationLaunchSetupPatch,
  AutomationLaunchPreferences
} from './launch/automation-launch-types'
import type { AutomationEventTrigger } from '../automation-event-triggers'
import type { AutomationBotTarget } from '../automation-bot-target'
import type { AutomationOnce } from '../automation-once'

export type {
  AutomationBotResultsTo,
  AutomationBotRunsIn,
  AutomationBotTarget
} from '../automation-bot-target'

export type AutomationWorkspaceMode = 'existing' | 'new_per_run'

export type AutomationExecutionTargetType = 'local' | 'ssh'

export type AutomationSchedulerOwner = 'local_host_service' | 'ssh_bridge' | 'remote_host_service'

export type AutomationMissedRunPolicy = 'run_once_within_grace'

export type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export type AutomationPrecheck = {
  command: string
  timeoutSeconds: number
}

/** Who created an automation, when Orca knows it was not the person. Set by Orca, never by the
 *  creator; `name` is the plugin's name then, so the label survives the plugin's removal. */
export type AutomationCreator = {
  kind: 'plugin'
  pluginKey: string
  name: string
  /** When the plugin was removed, disabled or blocked: it no longer owns the automation, and a
   *  plugin installed later under the same key does not either. */
  endedAt?: number
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
  /** Older hosts ignore this and see an automation with no project, which they refuse to run. */
  bot?: AutomationBotTarget
  /** Events that start a bot automation; without a schedule it stores EVENT_ONLY_SCHEDULE. */
  on?: AutomationEventTrigger[]
  /** A wait: runs once, on its first event or at `by`, then is deleted. Its schedule stays
   *  EVENT_ONLY_SCHEDULE, so a host that drops this never runs it on time. */
  once?: AutomationOnce
  /** @deprecated Legacy repo-id compatibility field. New code should persist
   *  runContext and use getAutomationRunRepoId() for fallback reads. Empty for a bot. */
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
  timezone: string
  /**
   * The owner named the zone (`--timezone`), so it holds on every host. Otherwise it is the zone
   * captured at creation: a server keeps it, a desktop follows its own clock. Older peers omit it.
   */
  timezoneExplicit?: boolean
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunPolicy: AutomationMissedRunPolicy
  missedRunGraceMinutes: number
  createdAt: number
  updatedAt: number
  createdBy?: AutomationCreator
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
  bot?: AutomationBotTarget
  on?: AutomationEventTrigger[]
  once?: AutomationOnce
  /** @deprecated Legacy repo-id compatibility field required for older stored
   *  automations and clients. Pair it with runContext for new writes. */
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
  setupDecision?: SetupDecision
  setupTrustHash?: string
  reuseSession?: boolean
  timezone: string
  timezoneExplicit?: boolean
  rrule: string
  dtstart: number
  enabled?: boolean
  missedRunGraceMinutes?: number
  createdBy?: AutomationCreator
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
    | 'bot'
    | 'on'
    | 'once'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
    | 'setupDecision'
    | 'setupTrustHash'
    | 'reuseSession'
    | 'timezone'
    | 'timezoneExplicit'
    | 'rrule'
    | 'dtstart'
    | 'enabled'
    | 'missedRunGraceMinutes'
    | 'createdBy'
  >
>
