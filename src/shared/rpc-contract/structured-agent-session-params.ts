import {
  SendBody,
  AgentSessionOptions,
  MAX_OPTION_LABEL,
  MAX_PROMPT_BYTES
} from './structured-agent-session-message-params'
export {
  SendBlock,
  MAX_BLOCKS,
  MAX_OPTION_LABEL,
  MAX_PROMPT_BYTES
} from './structured-agent-session-message-params'
import {
  Identifier,
  JournalCursor,
  MAX_ID_LENGTH,
  SessionId
} from './structured-agent-session-identifiers'
export {
  Identifier,
  JournalCursor,
  MAX_ID_LENGTH,
  SessionId
} from './structured-agent-session-identifiers'
import { z } from 'zod'
import { CREATE_TAB_FIELDS } from './structured-agent-session-create-tab-params'
import { isStructuredAgentId } from '../agent-session-provider-handle-encoding'
import { normalizeExecutionHostId } from '../execution-host'
import {
  AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES,
  AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH
} from '../agent-session-question-answer'
import {
  AGENT_SESSION_HISTORY_DIRECTIONS,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../agent-session-wire'
import { AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH } from '../agent-session-thread-goal-wire'

// Four Claude questions with all four generated choices occupy 610 chars when fully percent-encoded.
export const MAX_RESPONSE_OPTION_ID_LENGTH = AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH

/** Matches the journal's bounds on one grouped prompt. */
const MAX_QUESTION_ANSWER_QUESTIONS = 4
const MAX_QUESTION_ANSWER_OPTIONS = 64

/** One relaunch cannot offer more chats than a profile plausibly holds. */
export const MAX_RESTART_RESUME_SESSIONS = 512

export const MutationEnvelope = z
  .object({
    sessionId: SessionId,
    clientOperationId: Identifier('Invalid client operation id'),
    /** Null is the "must not exist yet" case; every other call fences. */
    expectedRuntimeFence: z.number().int().positive().nullable(),
    payloadFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'Payload fingerprint must be a sha256 hex digest')
  })
  .strict()

export const ProviderHandle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: Identifier('Invalid thread id') }).strict(),
  z
    .object({
      kind: z.literal('claude'),
      sessionId: Identifier('Invalid provider session id'),
      leafUuid: Identifier('Invalid leaf uuid').nullable()
    })
    .strict()
])

/** Host-registered agents; clients gate names beyond Claude/Codex on the registered-agents capability. */
export const StructuredAgent = z.string().refine(isStructuredAgentId, 'Invalid agent')

export const ExecutionHostId = z
  .string()
  .max(MAX_ID_LENGTH)
  .transform((value) => normalizeExecutionHostId(value))
  .refine((value): value is NonNullable<typeof value> => value !== null, {
    message: 'Invalid execution host id'
  })

export const ExecutionLocation = z
  .object({
    executionHostId: ExecutionHostId,
    wslDistro: Identifier('Invalid WSL distro').nullable(),
    workspaceId: Identifier('Invalid workspace id'),
    workspaceKind: z.enum(['git-worktree', 'folder'])
  })
  .strict()

export const AccountHome = z
  .object({
    variable: z.enum(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']),
    path: z.string().min(1).max(4096)
  })
  .strict()

/** Only Claude/Codex handles have wire forms; other agents attach through host-resolved intent. */
export const AttachParams = z
  .object({
    envelope: MutationEnvelope,
    location: ExecutionLocation,
    provider: z.enum(['codex', 'claude']),
    agent: Identifier('Invalid agent'),
    accountHome: AccountHome,
    runtimeKind: z.literal('native'),
    providerHandle: ProviderHandle
  })
  .strict()

/** Identity only: derive transcript/account paths host-side so clients cannot choose imported files or credential directories. */
export const ResumeSource = z
  .object({
    providerSessionId: Identifier('Invalid provider session id'),
    cliSource: z
      .object({
        workspaceId: Identifier('Invalid workspace id'),
        paneKey: Identifier('Invalid pane key')
      })
      .strict()
      .optional()
  })
  .strict()

export const CreateSupportParams = z
  .object({
    worktree: Identifier('Invalid worktree selector'),
    agent: StructuredAgent
  })
  .strict()

export const SendParams = z
  .object({
    envelope: MutationEnvelope,
    retryUnknown: z.literal(true).optional(),
    /** Host-held draft while active; gate strict payloads on agent-session.queued-messages.v1.
     * Operation fingerprint only, never body fingerprint. */
    delivery: z.literal('queue-if-active').optional(),
    /** Preserve composer options until dispatch; requires agent-session.send-options.v1. Operation fingerprint only. */
    options: AgentSessionOptions.optional(),
    // Strict payload: only hosts advertising the bound usage-limit send capability accept this.
    usageLimitContinuationOfTurnItemId: Identifier('Invalid source turn item id').optional(),
    body: SendBody
  })
  .strict()

export const CreateIntentParams = z
  .object({
    envelope: MutationEnvelope,
    worktree: Identifier('Invalid worktree selector'),
    agent: StructuredAgent,
    resumeFrom: ResumeSource.optional(),
    ...CREATE_TAB_FIELDS,
    /** Both fields require `agentSession.create.message.v1` on the executing host. */
    firstMessage: z
      .object({
        clientMessageId: Identifier('Invalid client message id'),
        body: SendParams.shape.body
      })
      .strict()
      .optional(),
    options: AgentSessionOptions.optional(),
    optionsMode: z.literal('replace-model-selection').optional()
  })
  .strict()

export const CreateParams = z.union([AttachParams, CreateIntentParams])

export const CancelParams = z
  .object({
    envelope: MutationEnvelope,
    // Absent: stop whatever the conversation has in flight. Present: only if that turn is current.
    turnId: Identifier('Invalid turn id').optional(),
    scope: z.literal('background-tasks').optional(),
    taskId: Identifier('Invalid task id').optional(),
    prompt: z
      .object({
        itemId: Identifier('Invalid item id'),
        expectedRevision: z.number().int().positive()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.taskId !== undefined && value.scope !== 'background-tasks') {
      ctx.addIssue({ code: 'custom', message: 'A task id requires background-task scope' })
    }
    if (value.prompt !== undefined && value.scope === 'background-tasks') {
      ctx.addIssue({ code: 'custom', message: 'A prompt cannot use background-task scope' })
    }
    if (value.turnId === undefined && (value.prompt !== undefined || value.scope !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'A prompt or background-task cancel names its turn' })
    }
  })

/** Queued draft actions require agent-session.queued-messages.v1; older hosts lack these methods. */
export const QueuedMessageActionParams = z
  .object({
    envelope: MutationEnvelope,
    messageId: Identifier('Invalid queued message id')
  })
  .strict()

/** Resume dispatch after Stop/restart pauses; gated like queued draft actions. */
export const QueuedMessagesResumeParams = z.object({ envelope: MutationEnvelope }).strict()

export const RespondParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id'),
    /** Compare-and-set: the revision the client had on screen. */
    expectedRevision: z.number().int().positive(),
    optionId: Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH)
  })
  .strict()

const QuestionAnswer = z
  .object({
    // Codex question ids are model-written and untrimmed; the host matches them exactly.
    questionId: z
      .string()
      .min(1, 'Invalid question id')
      .max(MAX_RESPONSE_OPTION_ID_LENGTH, 'Invalid question id'),
    optionIds: z
      .array(Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH))
      .max(MAX_QUESTION_ANSWER_OPTIONS),
    // Hashed verbatim by both peers, so no trim or transform here.
    other: z
      .string()
      .max(AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES)
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES,
        'Answer is too large'
      )
      .optional()
  })
  .strict()

export const RespondToQuestionParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id'),
    expectedRevision: z.number().int().positive(),
    /** An answer packed into one id, from clients that predate `answers`. */
    optionId: Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH).optional(),
    answers: z.array(QuestionAnswer).min(1).max(MAX_QUESTION_ANSWER_QUESTIONS).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.optionId === undefined) === (value.answers === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Send exactly one of an option id or answers' })
    }
    if (
      value.answers !== undefined &&
      Buffer.byteLength(JSON.stringify(value.answers), 'utf8') > MAX_PROMPT_BYTES
    ) {
      ctx.addIssue({ code: 'custom', message: 'Answer is too large' })
    }
  })

export const SetOptionParams = z.strictObject({
  envelope: MutationEnvelope,
  key: Identifier('Invalid option key'),
  value: z.string().max(MAX_OPTION_LABEL)
})

export const OptionsParams = z.object({ sessionId: SessionId }).strict()
export const ItemParams = OptionsParams.extend({ itemId: z.string().min(1) }).strict()
// Why optional: only a host advertising the workspace-sleep-mark capability is sent `markAsleep`.
export const SleepWorkspaceParams = z
  .object({ workspaceId: z.string().min(1), markAsleep: z.literal(true).optional() })
  .strict()
export const AcknowledgeAttentionParams = OptionsParams.extend({ observedCursor: JournalCursor })

export const AgentsParams = z.object({}).strict()

export const AvailabilityParams = z.strictObject({})

/** Session pins the account; otherwise use the account/config a launch in worktree would select.
 * Send waitForListing only after the host reports one in progress; old hosts refuse the key. */
export const ModelCatalogParams = z.strictObject({
  agent: StructuredAgent,
  sessionId: SessionId.optional(),
  worktree: Identifier('Invalid worktree selector').optional(),
  waitForListing: z.boolean().optional(),
  // Read saved data without starting a listing; gate on saved-only capability because older hosts refuse unknown keys.
  savedOnly: z.boolean().optional()
})

export const ConversationCommandParams = z
  .object({
    envelope: MutationEnvelope,
    command: z.enum(['clear', 'compact']),
    /** Queue active /compact only with agent-session.queued-commands.v1; older strict hosts refuse it.
     * /clear never queues: delivery is outside its fingerprint, so including it conflicts. */
    delivery: z.literal('queue-if-active').optional()
  })
  .strict()

export const ThreadGoalParams = z
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

/** One holder per surface, not client: leaving one view must not release another view of the same session. */
export const HoldParams = z
  .object({ sessionId: SessionId, holderId: Identifier('Invalid holder id') })
  .strict()

/** Host-derived restart offers; dismiss listed session IDs, or all when absent.
 * Clients only name sessions the host listed, avoiding unknown-key requests to older hosts. */
export const RestartResumableParams = z
  .object({ sessionIds: z.array(SessionId).max(MAX_RESTART_RESUME_SESSIONS).optional() })
  .strict()

/** Absent selects the whole offered set; IDs narrow it. Host rechecks eligibility, excluding invented IDs. */
export const RestartResumeParams = z
  .object({ sessionIds: z.array(SessionId).max(MAX_RESTART_RESUME_SESSIONS).optional() })
  .strict()

export const HistoryParams = z
  .object({
    sessionId: SessionId,
    direction: z.enum(AGENT_SESSION_HISTORY_DIRECTIONS),
    cursor: JournalCursor.optional(),
    limit: z.number().int().positive().max(AGENT_SESSION_HISTORY_MAX_LIMIT).optional()
  })
  .strict()

export const SubscribeParams = OptionsParams.extend({ cursor: JournalCursor.optional() }).strict()

// Not strict: an older host ignores these params entirely, and this host must ignore a newer client's.
export const SubscribeTurnCompletionsParams = z.object({ includePrompts: z.boolean().optional() })

export const UnsubscribeParams = z
  .object({
    sessionId: SessionId,
    subscriptionId: Identifier('Invalid subscription id').optional()
  })
  .strict()

/** Read-only owner classification retained for restart safety; mutation handoff is separate. */
export const HandoffStatusParams = z.object({ sessionId: SessionId }).strict()

export const RewindParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id', 4096),
    expectedEpoch: Identifier('Invalid journal epoch')
  })
  .strict()
