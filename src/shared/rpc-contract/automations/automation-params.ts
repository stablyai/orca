import * as z from 'zod'
import { ChoicePatch, OptionKey } from '../agent-launch/agent-launch-settings-params'
import { AGENT_PERMISSION_CHOICES } from '../../agent-launch/permissions/tui-agent-permission-choice'
import {
  AutomationBotTarget,
  AutomationEventTriggers,
  AutomationOnceParam
} from '../automation-bot-params'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import {
  OptionalBoolean,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString,
  requiredNumber,
  requiredString
} from '../rpc-param-primitives'
import { normalizeExecutionHostId } from '../../execution-host/execution-host'
import { isValidAutomationSchedule } from '../../automations/scheduling/automation-schedule-parsing'
import {
  MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS,
  normalizeAutomationPrecheckTimeoutSeconds
} from '../../automations/launch/automation-precheck'

export const TuiAgent = requiredString('Missing provider').refine(isTuiAgent, {
  message: 'Unknown provider'
})

export const AutomationWorkspaceMode = z.enum(['existing', 'new_per_run']).optional()

export const SetupDecision = z.enum(['inherit', 'run', 'skip']).optional()

export const ExecutionHostId = requiredString('Missing host id').transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'Invalid host id' })
    return z.NEVER
  }
  return hostId
})

export const AutomationSchedule = requiredString('Missing trigger').refine(
  isValidAutomationSchedule,
  {
    message: 'Invalid automation trigger'
  }
)

export const AutomationPrecheck = z
  .object({
    command: requiredString('Missing precheck command'),
    timeoutSeconds: OptionalPositiveInt.transform((value) =>
      normalizeAutomationPrecheckTimeoutSeconds(value)
    ).refine((value) => value <= MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS, {
      message: 'Precheck timeout is too large'
    })
  })
  .nullable()
  .optional()

export const OptionalNullablePlainString = z
  .unknown()
  .transform((value) => (value === null || typeof value === 'string' ? value : undefined))
  .pipe(z.union([z.string(), z.null(), z.undefined()]))
  .optional()

// A GitHub identity is only usable with both fields present and non-blank.
const GithubIdentityField = z.string().refine((value) => value.trim().length > 0, {
  message: 'Required'
})

export const TaskProviderIdentity = z
  .discriminatedUnion('provider', [
    z
      .object({
        provider: z.literal('github'),
        // Reject blank identity without trimming: normalization treats it as absent, but parsing must preserve nonblank bytes.
        owner: GithubIdentityField,
        repo: GithubIdentityField,
        host: z.string().optional()
      })
      .passthrough(),
    z
      .object({
        provider: z.literal('gitlab'),
        projectId: z.string().nullable().optional(),
        namespace: z.string().nullable().optional(),
        project: z.string().nullable().optional(),
        webUrl: z.string().nullable().optional()
      })
      .passthrough(),
    z
      .object({
        provider: z.literal('linear'),
        workspaceId: z.string().nullable().optional(),
        workspaceName: z.string().nullable().optional(),
        teamId: z.string().nullable().optional(),
        teamKey: z.string().nullable().optional()
      })
      .passthrough(),
    z
      .object({
        provider: z.literal('jira'),
        siteId: z.string().nullable().optional(),
        siteUrl: z.string().nullable().optional(),
        projectKey: z.string().nullable().optional()
      })
      .passthrough()
  ])
  .optional()
  .nullable()

export const TaskSourceContext = z
  .object({
    kind: z.literal('task-source'),
    provider: z.enum(['github', 'gitlab', 'linear', 'jira']),
    projectId: requiredString('Missing source project id'),
    hostId: ExecutionHostId,
    projectHostSetupId: OptionalNullablePlainString,
    repoId: OptionalNullablePlainString,
    providerIdentity: TaskProviderIdentity,
    accountLabel: OptionalNullablePlainString
  })
  .optional()
  .nullable()

export const WorkspaceRunContext = z
  .object({
    kind: z.literal('workspace-run'),
    projectId: requiredString('Missing run project id'),
    hostId: ExecutionHostId,
    projectHostSetupId: requiredString('Missing project host setup id'),
    repoId: requiredString('Missing repo id'),
    path: requiredString('Missing run path')
  })
  .optional()
  .nullable()

export const SshTargetGeneration = requiredNumber('Missing SSH target generation').refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: 'Invalid SSH target generation' }
)

export const OwnedSshSelector = z.object({
  kind: z.literal('ssh'),
  targetId: requiredString('Missing SSH target id'),
  targetGeneration: SshTargetGeneration
})

/** Orphan is accepted here, unlike a destination: a record with no executable host is still deletable. */
export const OwnerPreconditionSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  OwnedSshSelector,
  z.object({ kind: z.literal('orphan') })
])

export const DestinationSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  OwnedSshSelector
])

export const ExpectedOwner = z.object({ selector: OwnerPreconditionSelector }).optional()

export const Destination = z.object({ selector: DestinationSelector }).optional()

export const ListScopeSelector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({
    kind: z.literal('ssh'),
    targetId: requiredString('Missing SSH target id'),
    expectedTargetGeneration: SshTargetGeneration
  }),
  z.object({ kind: z.literal('orphan') })
])

/** An omitted selector is the legacy request; old clients keep the authority's complete list. */
export const AutomationList = z.object({ selector: ListScopeSelector.optional() })

export const AutomationId = z.object({
  id: requiredString('Missing automation id'),
  expectedOwner: ExpectedOwner
})

export const AutomationRuns = z.object({
  automationId: OptionalString,
  expectedOwner: ExpectedOwner,
  limit: OptionalPositiveInt,
  cursor: OptionalString,
  /** Reply with a byte-bounded page of rows whose output is cut to a preview. */
  preview: OptionalBoolean,
  /** Reply with this one full run as `{ run }`; requires `automationId`. */
  runId: OptionalString
})

export const AutomationPrecheckRequest = z.object({
  automationId: requiredString('Missing automation id'),
  runId: requiredString('Missing automation run id')
})

const AutomationRunStatus = z.enum([
  'pending',
  'dispatching',
  'dispatched',
  'completed',
  'skipped_precheck',
  'skipped_missed',
  'skipped_unavailable',
  'skipped_needs_interactive_auth',
  'dispatch_failed'
])

const AutomationPrecheckResult = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().finite(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  error: z.string().nullable(),
  startedAt: z.number().finite(),
  completedAt: z.number().finite()
})

const AutomationRunOutputSnapshot = z.object({
  format: z.literal('plain_text'),
  content: z.string(),
  capturedAt: z.number().finite(),
  truncated: z.boolean()
})

const AutomationRunUsage = z.object({
  status: z.enum(['known', 'unavailable']),
  provider: z.enum(['claude', 'codex']).nullable(),
  model: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheWriteTokens: z.number().int().nullable(),
  reasoningOutputTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  estimatedCostUsd: z.number().nullable(),
  estimatedCostSource: z.literal('api_equivalent').nullable(),
  providerSessionId: z.string().nullable(),
  attribution: z.literal('provider_session_time_window').nullable(),
  collectedAt: z.number().finite(),
  unavailableReason: z
    .enum([
      'run_not_finished',
      'provider_unsupported',
      'remote_usage_unavailable',
      'usage_not_enabled',
      'scan_failed',
      'no_matching_session',
      'ambiguous_session'
    ])
    .nullable(),
  unavailableMessage: z.string().nullable()
})

export const AutomationDispatchResult = z.object({
  runId: requiredString('Missing automation run id'),
  status: AutomationRunStatus,
  workspaceId: z.string().nullable().optional(),
  workspaceDisplayName: z.string().nullable().optional(),
  terminalSessionId: z.string().nullable().optional(),
  terminalPaneKey: z.string().nullable().optional(),
  terminalPtyId: z.string().nullable().optional(),
  outputSnapshot: AutomationRunOutputSnapshot.nullable().optional(),
  precheckResult: AutomationPrecheckResult.nullable().optional(),
  usage: AutomationRunUsage.nullable().optional(),
  error: z.string().nullable().optional()
})

// Why strict: null or a non-string must fail rather than fall back to "omitted", which preserves.
const ExtraAgentArgs = z.string({ message: 'Extra agent arguments must be text.' }).optional()

export const AutomationCanonicalLaunchSetup = z.strictObject({
  surface: z.enum(['chat', 'terminal']).optional(),
  extraAgentArgs: z.string().optional(),
  launchPreferences: ChoicePatch.extend({
    permissionMode: z.enum(AGENT_PERMISSION_CHOICES).optional()
  }).optional(),
  agentArgs: z
    .string()
    .refine((value) => !value.includes('\0'))
    .nullable()
    .optional()
})

export const AutomationLaunchSetupPatch = z
  .strictObject({
    surface: z.enum(['chat', 'terminal']).optional(),
    choices: ChoicePatch.optional(),
    arguments: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('legacy-extras'), value: z.string() }),
        z.strictObject({
          kind: z.literal('value'),
          value: z.string().refine((value) => !value.includes('\0'))
        }),
        z.strictObject({ kind: z.literal('empty') }),
        z.strictObject({ kind: z.literal('inherit') })
      ])
      .optional(),
    sources: z
      .strictObject({
        arguments: z
          .discriminatedUnion('kind', [
            z.strictObject({
              kind: z.literal('value'),
              value: z.string().refine((value) => !value.includes('\0'))
            }),
            z.strictObject({ kind: z.literal('empty') }),
            z.strictObject({ kind: z.literal('inherit') })
          ])
          .optional(),
        legacyArguments: z.string().optional(),
        extraAgentArgs: z.string().optional(),
        retiredChoices: z
          .array(
            z
              .string()
              .refine(
                (key) =>
                  key === 'model' ||
                  key === 'permissionMode' ||
                  (key.startsWith('options.') && OptionKey.safeParse(key.slice(8)).success)
              )
          )
          .optional()
      })
      .optional(),
    copy: AutomationCanonicalLaunchSetup.optional()
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Choose an automation launch change.'
  })

export const AutomationCreate = z.object({
  creationKey: OptionalString,
  name: requiredString('Missing automation name'),
  prompt: requiredString('Missing automation prompt'),
  precheck: AutomationPrecheck,
  agentId: TuiAgent,
  extraAgentArgs: ExtraAgentArgs,
  launchSetupPatch: AutomationLaunchSetupPatch.optional(),
  runContext: WorkspaceRunContext,
  sourceContext: TaskSourceContext,
  bot: AutomationBotTarget.optional(),
  on: AutomationEventTriggers,
  once: AutomationOnceParam,
  repo: OptionalString,
  workspace: OptionalString,
  workspaceMode: AutomationWorkspaceMode,
  baseBranch: OptionalPlainString,
  setupDecision: SetupDecision,
  setupTrustHash: z.string().max(128).optional(),
  reuseSession: OptionalBoolean,
  timezone: OptionalString,
  timezoneExplicit: OptionalBoolean,
  rrule: AutomationSchedule,
  dtstart: requiredNumber('Missing trigger start time'),
  enabled: OptionalBoolean,
  missedRunGraceMinutes: OptionalPositiveInt,
  destination: Destination,
  // The native chat whose agent ran the command, to show the saved automation there.
  callerSessionId: OptionalString,
  // No --runs-in was given: a wait, or a teammate's automation, runs in that chat when it is one of the bot's own.
  runsInDefault: z.literal(true).optional(),
  // What a CLI from before runsInDefault sends for a wait given no --runs-in.
  waitInCallerChat: z.literal(true).optional()
})

export const AutomationUpdateFields = z.object({
  name: OptionalString,
  prompt: OptionalString,
  precheck: AutomationPrecheck,
  agentId: TuiAgent.optional(),
  extraAgentArgs: ExtraAgentArgs,
  launchSetupPatch: AutomationLaunchSetupPatch.optional(),
  runContext: WorkspaceRunContext,
  sourceContext: TaskSourceContext,
  bot: AutomationBotTarget.optional(),
  on: AutomationEventTriggers,
  once: AutomationOnceParam,
  repo: OptionalString,
  workspace: OptionalString,
  workspaceMode: AutomationWorkspaceMode,
  // Why: update patches distinguish omitted from null so callers can clear a saved base branch.
  baseBranch: OptionalNullablePlainString,
  setupDecision: SetupDecision,
  setupTrustHash: z.string().max(128).optional(),
  reuseSession: OptionalBoolean,
  timezone: OptionalString,
  timezoneExplicit: OptionalBoolean,
  rrule: AutomationSchedule.optional(),
  dtstart: requiredNumber('Missing trigger start time').optional(),
  enabled: OptionalBoolean,
  missedRunGraceMinutes: OptionalPositiveInt
})

export const AutomationUpdate = z.object({
  id: requiredString('Missing automation id'),
  updates: AutomationUpdateFields,
  expectedOwner: ExpectedOwner,
  destination: Destination,
  callerSessionId: OptionalString,
  // An edit relying on the current new-per-run mode is refused if the stored mode changed first.
  expectedWorkspaceMode: z.literal('new_per_run').optional()
})
