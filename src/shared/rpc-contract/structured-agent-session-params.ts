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
import { isAgentSessionSurfaceTabId } from '../agent-session-surface-tab-id'
import { isStructuredAgentId } from '../agent-session-provider-handle-encoding'
import { normalizeExecutionHostId } from '../execution-host'
import {
  AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES,
  AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH
} from '../agent-session-question-answer'
import {
  AGENT_SESSION_HISTORY_DIRECTIONS,
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH
} from '../agent-session-wire'

// Four Claude questions with all four generated choices occupy 610 chars when fully percent-encoded.
export const MAX_RESPONSE_OPTION_ID_LENGTH = AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH

export const MAX_PROMPT_BYTES = 256 * 1024

/** Matches the journal's bounds on one grouped prompt. */
const MAX_QUESTION_ANSWER_QUESTIONS = 4
const MAX_QUESTION_ANSWER_OPTIONS = 64

export const MAX_BLOCKS = 64

export const MAX_OPTION_LABEL = 512

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

/** Any agent a host may register. The host refuses one it did not register; a client sends one
 *  beyond Claude and Codex only to a host advertising the registered-agents capability. */
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

/** Attaching by a client-supplied handle stays Claude/Codex: only their handles have a wire form, and
 *  every client creates other agents by intent, which the host resolves. */
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

/** An identity, and nothing the host would otherwise read off disk. A transcript path or account
 *  home here would let a client choose which file this host imports and which credential directory
 *  the provider child launches against; both are derived host-side from this id instead. */
export const ResumeSource = z
  .object({
    providerSessionId: Identifier('Invalid provider session id')
  })
  .strict()

export const CreateIntentParams = z
  .object({
    envelope: MutationEnvelope,
    worktree: Identifier('Invalid worktree selector'),
    agent: StructuredAgent,
    resumeFrom: ResumeSource.optional(),
    /**
     * The tab id the client reserved for this chat, so it can place the tab before the reply. The
     * host owns the id from here: it is persisted on the session record and is what the host's tab
     * snapshot will publish, so it must be a host tab id, as `agent.launch` requires of `paneKey`.
     *
     * This object is strict, so an older host refuses a payload carrying it. A client sends it
     * only after `AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY` is advertised.
     */
    tabId: z.string().refine(isAgentSessionSurfaceTabId, 'Invalid chat tab ID').optional()
  })
  .strict()

export const CreateParams = z.union([AttachParams, CreateIntentParams])

export const CreateSupportParams = z
  .object({
    worktree: Identifier('Invalid worktree selector'),
    agent: StructuredAgent
  })
  .strict()

/** Clients may only author user turns. Accepting an assistant or tool role here
 *  would let one client write words into the agent's mouth in another's
 *  timeline, and the provider — not the client — owns those. */
export const SendBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('image-ref'),
      path: z.string().min(1).max(4096).optional(),
      url: z.string().min(1).max(4096).optional(),
      alt: z.string().max(MAX_OPTION_LABEL).optional()
    })
    .strict()
    .refine(
      (value) => Boolean(value.path) !== Boolean(value.url),
      'Provide exactly one of path/url'
    )
])

export const SendParams = z
  .object({
    envelope: MutationEnvelope,
    retryUnknown: z.literal(true).optional(),
    /** Queue the send as a host-held draft while the main agent is working. Strict object, so an
     *  older host refuses it: clients send it only when `agent-session.queued-messages.v1` is
     *  advertised. Participates in the operation fingerprint, never the body fingerprint. */
    delivery: z.literal('queue-if-active').optional(),
    body: z
      .object({
        kind: z.literal('message'),
        role: z.literal('user'),
        blocks: z.array(SendBlock).min(1).max(MAX_BLOCKS)
      })
      .strict()
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value.blocks), 'utf8') <= MAX_PROMPT_BYTES,
        'Message is too large'
      )
  })
  .strict()

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

/** `agentSession.queuedMessageSend` / `agentSession.queuedMessageDelete`. Gated on
 *  `agent-session.queued-messages.v1`; an older host lacks the methods entirely. */
export const QueuedMessageActionParams = z
  .object({
    envelope: MutationEnvelope,
    messageId: Identifier('Invalid queued message id')
  })
  .strict()

/** `agentSession.queuedMessagesResume`: ends the queue's pause (a Stop's, or a
 *  restart's) so the cards send again. Gated like the draft actions above. */
export const QueuedMessagesResumeParams = z.object({ envelope: MutationEnvelope }).strict()

export {
  QueuedMessagesPageParams,
  QueuedMessageReadParams
} from './structured-agent-session-queue-page-params'

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

export const SetOptionParams = z
  .object({
    envelope: MutationEnvelope,
    key: Identifier('Invalid option key'),
    value: z.string().max(MAX_OPTION_LABEL)
  })
  .strict()

export const OptionsParams = z.object({ sessionId: SessionId }).strict()
export const AcknowledgeAttentionParams = OptionsParams.extend({ observedCursor: JournalCursor })

/** `agentSession.agents` takes nothing: the list is the host's, whichever client asks. */
export const AgentsParams = z.object({}).strict()

/** `sessionId` scopes the catalog to that session's pinned account; without a
 *  session record the host keys it by the account a new launch would pin.
 *  `worktree` names where a new chat runs, whose own config may replace the default.
 *  `waitForListing` holds the answer until the listing the host reported in progress lands; send
 *  it only after that report, because a host that predates it refuses the unknown key. */
export const ModelCatalogParams = z.strictObject({
  agent: StructuredAgent,
  sessionId: SessionId.optional(),
  worktree: Identifier('Invalid worktree selector').optional(),
  waitForListing: z.boolean().optional()
})

export const ConversationCommandParams = z
  .object({
    envelope: MutationEnvelope,
    command: z.enum(['clear', 'compact']),
    /** A /compact while the agent is working waits as a host-held card, like a queued send.
     *  Strict object, so an older host refuses it: clients send it only when
     *  `agent-session.queued-commands.v1` is advertised. A /clear never waits: its operation
     *  fingerprints no `delivery`, so one sent with it is refused as a conflict. */
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

/** One surface's claim on one session. The id names the surface, not the client: two chat views
 *  looking at the same session are two holders, and either leaving must not release
 *  the other's. */
export const HoldParams = z
  .object({ sessionId: SessionId, holderId: Identifier('Invalid holder id') })
  .strict()

/** A launch's offer to resume what the last teardown recorded as working; the set is the host's to
 *  derive, never a client's to assert. Listing takes nothing. Dismissing takes the sessions to
 *  forget, or nothing to forget them all; a client only ever names sessions the host itself listed,
 *  so an older host that rejects the key is never asked to. */
export const RestartResumableParams = z
  .object({ sessionIds: z.array(SessionId).max(MAX_RESTART_RESUME_SESSIONS).optional() })
  .strict()

/** Omitting `sessionIds` takes the whole offered set; naming them takes that subset. Either way the
 *  host re-derives eligibility, so an id a client invents is simply not in the set. */
export const RestartResumeParams = z
  .object({ sessionIds: z.array(SessionId).max(MAX_RESTART_RESUME_SESSIONS).optional() })
  .strict()

export const HistoryParams = z.strictObject({
  sessionId: SessionId,
  direction: z.enum(AGENT_SESSION_HISTORY_DIRECTIONS),
  cursor: JournalCursor.optional(),
  limit: z.number().int().positive().max(AGENT_SESSION_HISTORY_MAX_LIMIT).optional(),
  queueView: z.literal('paged-v1').optional()
})

export const SubscribeParams = z.strictObject({
  sessionId: SessionId,
  cursor: JournalCursor.optional(),
  queueView: z.literal('paged-v1').optional()
})

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
