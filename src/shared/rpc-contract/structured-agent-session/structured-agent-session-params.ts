import * as z from 'zod'
import { BotLinkOpenTargetSchema } from '../../bots/bot-link-open-target'
import { CompactInstructions } from './structured-agent-session-message-params'
import { TerminalClose } from '../terminal/terminal-unary-params'
import { Identifier, JournalCursor, SessionId } from './structured-agent-session-identifiers'
import {
  AGENT_SESSION_HISTORY_DIRECTIONS,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../../agent-session/agent-session-wire'
import { AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH } from '../../agent-session/thread-goals/agent-session-thread-goal-wire'
import { MutationEnvelope } from './structured-agent-session-mutation-envelope'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  CreateIntentParams,
  OptionsParams,
  StructuredAgent
} from './structured-agent-session-core-params'

export {
  ProviderHandle,
  StructuredAgent,
  ExecutionHostId,
  ExecutionLocation,
  AccountHome,
  AttachParams,
  CreateSupportParams,
  SendParams,
  CreateIntentParams,
  CreateParams,
  CancelParams,
  QueuedMessageActionParams,
  QueuedMessagesResumeParams,
  RespondParams,
  SetOptionParams,
  OptionsParams
} from './structured-agent-session-core-params'

/** One relaunch cannot offer more chats than a profile plausibly holds. */
export const MAX_RESTART_RESUME_SESSIONS = 512

export const RevealParams = lazyZodSchema(() =>
  OptionsParams.extend({
    botLinkTarget: BotLinkOpenTargetSchema.optional(),
    navigation: z.literal('caller').optional()
  }).strict()
)

export const SwitchToChatParams = lazyZodSchema(() =>
  OptionsParams.extend({
    execution: z
      .object({
        invocationId: Identifier('Invalid invocation'),
        observe: z.boolean().optional(),
        receipt: z
          .object({
            generation: Identifier('Invalid generation'),
            shown: z.boolean(),
            retained: z.boolean().optional(),
            converged: z.boolean().optional()
          })
          .strict()
          .optional(),
        create: CreateIntentParams.omit({ firstMessage: true }).optional(),
        source: TerminalClose.required().optional()
      })
      .strict()
      .optional()
  }).strict()
)

export const SwitchToTerminalParams = lazyZodSchema(() =>
  OptionsParams.extend({
    execution: z
      .object({
        invocationId: Identifier('Invalid invocation'),
        observe: z.boolean().optional(),
        receipt: z
          .object({
            generation: Identifier('Invalid generation'),
            shown: z.boolean(),
            retained: z.boolean().optional(),
            converged: z.boolean().optional()
          })
          .strict()
          .optional(),
        sourceTabId: Identifier('Invalid tab').optional(),
        groupId: Identifier('Invalid group').optional(),
        commandOverride: z.string().max(8192).optional()
      })
      .strict()
      .optional()
  }).strict()
)

export const ItemParams = lazyZodSchema(() =>
  OptionsParams.extend({ itemId: z.string().min(1) }).strict()
)

export const ToolCallerParams = lazyZodSchema(() =>
  z.object({ token: z.string().min(1).max(256) }).strict()
)

// Why optional: only a host advertising the workspace-sleep-mark capability is sent `markAsleep`.
export const SleepWorkspaceParams = lazyZodSchema(() =>
  z.object({ workspaceId: z.string().min(1), markAsleep: z.literal(true).optional() }).strict()
)

export const AcknowledgeAttentionParams = lazyZodSchema(() =>
  OptionsParams.extend({ observedCursor: JournalCursor })
)

export const AgentsParams = lazyZodSchema(() => z.object({}).strict())

export const AvailabilityParams = lazyZodSchema(() => z.strictObject({}))

/** Session pins the account; otherwise use the account/config a launch in worktree would select.
 * Send waitForListing only after the host reports one in progress; old hosts refuse the key. */
export const ModelCatalogParams = lazyZodSchema(() =>
  z.strictObject({
    agent: StructuredAgent,
    sessionId: SessionId.optional(),
    worktree: Identifier('Invalid worktree selector').optional(),
    waitForListing: z.boolean().optional(),
    // Read saved data without starting a listing; gate on saved-only capability because older hosts refuse unknown keys.
    savedOnly: z.boolean().optional(),
    // Lists the agent's catalog again first; gate on the relist capability for the same reason.
    relist: z.literal(true).optional(),
    selectedModel: Identifier('Invalid selected model').optional()
  })
)

export const ConversationCommandParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      command: z.enum(['clear', 'compact']),
      /** Only where the session's options report compactInstructions: older strict hosts refuse it. */
      instructions: CompactInstructions.optional(),
      /** Queue active /compact only with agent-session.queued-commands.v1; older strict hosts refuse it.
       * /clear never queues: delivery is outside its fingerprint, so including it conflicts. */
      delivery: z.literal('queue-if-active').optional()
    })
    .strict()
    .refine((params) => params.instructions === undefined || params.command === 'compact', {
      message: 'Only /compact takes instructions'
    })
)

export const ThreadGoalParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      change: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('set'),
            objective: z
              .string()
              .max(AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH)
              .refine((value) => value.trim().length > 0, 'Objective is empty')
          })
          .strict(),
        z.object({ kind: z.literal('status'), status: z.enum(['active', 'paused']) }).strict(),
        z.object({ kind: z.literal('clear') }).strict()
      ])
    })
    .strict()
)

/** One holder per surface, not client: leaving one view must not release another view of the same session. */
export const HoldParams = lazyZodSchema(() =>
  z.object({ sessionId: SessionId, holderId: Identifier('Invalid holder id') }).strict()
)

/** Host-derived restart offers; dismiss listed session IDs, or all when absent.
 * Clients only name sessions the host listed, avoiding unknown-key requests to older hosts. */
export const RestartResumableParams = lazyZodSchema(() =>
  z.object({ sessionIds: z.array(SessionId).max(MAX_RESTART_RESUME_SESSIONS).optional() }).strict()
)

/** Absent selects the whole offered set; IDs narrow it. Host rechecks eligibility, excluding invented IDs. */
export const RestartResumeParams = lazyZodSchema(() =>
  z.object({ sessionIds: z.array(SessionId).max(MAX_RESTART_RESUME_SESSIONS).optional() }).strict()
)

/** Waits for this start's own continuation of what the last run cut off; `taken` answers once it
 *  has reserved its chats, before any agent starts. */
export const RestartLaunchSettledParams = lazyZodSchema(() =>
  z.object({ until: z.literal('taken').optional() }).strict()
)

export const HistoryParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      direction: z.enum(AGENT_SESSION_HISTORY_DIRECTIONS),
      cursor: JournalCursor.optional(),
      limit: z.number().int().positive().max(AGENT_SESSION_HISTORY_MAX_LIMIT).optional()
    })
    .strict()
)

// Not strict: an older host ignores these params entirely, and this host must ignore a newer client's.
export const SubscribeTurnCompletionsParams = lazyZodSchema(() =>
  z.object({ includePrompts: z.boolean().optional() })
)

export const UnsubscribeParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      subscriptionId: Identifier('Invalid subscription id').optional()
    })
    .strict()
)

/** Read-only owner classification retained for restart safety; mutation handoff is separate. */
export const HandoffStatusParams = lazyZodSchema(() => z.object({ sessionId: SessionId }).strict())

export const RewindParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      itemId: Identifier('Invalid item id', 4096),
      expectedEpoch: Identifier('Invalid journal epoch')
    })
    .strict()
)
