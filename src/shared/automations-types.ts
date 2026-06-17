import type { TuiAgent } from './types'
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
export type AutomationRunTrigger = 'scheduled' | 'manual' | 'webhook'

/** How an incoming webhook request is authenticated before it may trigger the
 *  automation. Provider-agnostic on purpose (issue #2): 'token' covers
 *  GitLab's plain `X-Gitlab-Token` shared-secret header, 'hmac_sha256' covers
 *  GitHub's `X-Hub-Signature-256` and Gitea's `X-Gitea-Signature` body
 *  signatures, and 'none' leaves the URL's unguessable id as the only secret. */
export type AutomationWebhookSecretMode = 'none' | 'token' | 'hmac_sha256'

export type AutomationWebhookConfig = {
  enabled: boolean
  secretMode: AutomationWebhookSecretMode
  /** The shared secret / HMAC key. Null when secretMode is 'none'.
   *  Stored in plaintext in the local settings JSON (acceptable for a local
   *  desktop app); encrypting at rest via Electron safeStorage is a future
   *  improvement. Zero it on rotation/revocation. */
  secret: string | null
}

/** Live state of the inbound-webhook listener, surfaced to the renderer so the
 *  automation editor can show the reachable URL and any bind error. */
export type WebhookServerEndpoint = {
  running: boolean
  bindAddress: string
  port: number
  error: string | null
}

/** The captured request that triggered a webhook run. Stored on the run (size
 *  capped) so the run stays understandable in history and so the body can be
 *  appended to the agent prompt as additional context. */
export type AutomationWebhookDelivery = {
  body: string
  contentType: string | null
  truncated: boolean
  receivedAt: number
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

/** Per-automation override of how the selected agent is launched. Lets an
 *  automation configure the agent it picks (issue #7) instead of only naming
 *  it. Each field is independent and optional: when unset the run falls back to
 *  the global per-agent default (settings.agentDefaultArgs/agentDefaultEnv).
 *  - launchArgs: replaces the global default CLI args when non-empty.
 *  - env: merged over (and wins against) the global per-agent env at launch.
 *  - model: injected as the agent's model CLI flag when the agent has a known
 *    flag (see tui-agent-models); free-text is allowed for unlisted models. */
export type AutomationAgentConfig = {
  launchArgs?: string | null
  env?: Record<string, string> | null
  model?: string | null
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
  /** Per-automation agent launch override (issue #7). Null/absent → use the
   *  global per-agent launch defaults. */
  agentConfig?: AutomationAgentConfig | null
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
  reuseSession: boolean
  timezone: string
  rrule: string
  dtstart: number
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  missedRunPolicy: AutomationMissedRunPolicy
  missedRunGraceMinutes: number
  /** Webhook trigger config. Null/absent for schedule-only automations. */
  webhook?: AutomationWebhookConfig | null
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
  outputSnapshot: AutomationRunOutputSnapshot | null
  precheckResult: AutomationPrecheckResult | null
  usage: AutomationRunUsage | null
  /** Present only for webhook-triggered runs; carries the request body that
   *  is appended to the agent prompt as additional context. */
  webhookDelivery?: AutomationWebhookDelivery | null
  error: string | null
  startedAt: number | null
  dispatchedAt: number | null
  createdAt: number
}

export type AutomationCreateInput = {
  name: string
  prompt: string
  precheck?: AutomationPrecheck | null
  agentId: TuiAgent
  agentConfig?: AutomationAgentConfig | null
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
  /** @deprecated Legacy repo-id compatibility field required for older stored
   *  automations and clients. Pair it with runContext for new writes. */
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  baseBranch?: string | null
  reuseSession?: boolean
  timezone: string
  rrule: string
  dtstart: number
  enabled?: boolean
  missedRunGraceMinutes?: number
  webhook?: AutomationWebhookConfig | null
}

export type AutomationUpdateInput = Partial<
  Pick<
    Automation,
    | 'name'
    | 'prompt'
    | 'precheck'
    | 'agentId'
    | 'agentConfig'
    | 'runContext'
    | 'sourceContext'
    | 'projectId'
    | 'workspaceMode'
    | 'workspaceId'
    | 'baseBranch'
    | 'reuseSession'
    | 'timezone'
    | 'rrule'
    | 'dtstart'
    | 'enabled'
    | 'missedRunGraceMinutes'
    | 'webhook'
  >
>

/** A user-created, persisted automation template (issue #7). Captures only the
 *  "soft" fields of an automation — what to run and on what cadence — and never
 *  the run target (workspace/project), precheck, or webhook, which are set per
 *  automation when the template is applied. Mirrors the field shape used to
 *  pre-fill the create dialog so applying a template is a straight draft merge. */
export type UserAutomationTemplate = {
  id: string
  /** Picker label for the template itself. */
  label: string
  /** Optional one-line description shown under the label. */
  description: string
  /** Default automation name pre-filled when the template is applied. */
  name: string
  prompt: string
  agentId: TuiAgent
  agentConfig?: AutomationAgentConfig | null
  preset: AutomationSchedulePreset
  time?: string | null
  dayOfWeek?: string | null
  /** Cron expression used only when preset is 'custom'. */
  customSchedule?: string | null
  missedRunGraceMinutes?: string | null
  createdAt: number
  updatedAt: number
}

export type UserAutomationTemplateInput = {
  label: string
  description?: string
  name: string
  prompt: string
  agentId: TuiAgent
  agentConfig?: AutomationAgentConfig | null
  preset: AutomationSchedulePreset
  time?: string | null
  dayOfWeek?: string | null
  customSchedule?: string | null
  missedRunGraceMinutes?: string | null
}

export type AutomationDispatchRequest = {
  automation: Automation
  run: AutomationRun
}

export type AutomationDispatchResult = {
  runId: string
  status: AutomationRunStatus
  workspaceId?: string | null
  workspaceDisplayName?: string | null
  terminalSessionId?: string | null
  outputSnapshot?: AutomationRunOutputSnapshot | null
  precheckResult?: AutomationPrecheckResult | null
  usage?: AutomationRunUsage | null
  error?: string | null
}

// External-automation (Hermes/OpenClaw) types live in their own module; kept
// re-exported here so existing importers of automations-types are unaffected.
export type {
  ExternalAutomationProvider,
  ExternalAutomationManagerStatus,
  ExternalAutomationAction,
  ExternalAutomationRunStatus,
  ExternalAutomationTarget,
  ExternalAutomationJob,
  ExternalAutomationRun,
  ExternalAutomationRunsPage,
  ExternalAutomationRunsInput,
  ExternalAutomationCreateInput,
  ExternalAutomationUpdateInput,
  ExternalAutomationManager,
  ExternalAutomationActionInput
} from './external-automations-types'
