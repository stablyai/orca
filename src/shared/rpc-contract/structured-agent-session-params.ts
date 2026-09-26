import { z } from 'zod'
import { isAgentSessionSurfaceTabId } from '../agent-session-surface-tab-id'
import { isAgentSessionId } from '../agent-session-record'
import { normalizeExecutionHostId } from '../execution-host'
import {
  AGENT_SESSION_ID_MAX_LENGTH,
  AGENT_SESSION_HISTORY_DIRECTIONS,
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  AGENT_SESSION_THREAD_GOAL_OBJECTIVE_MAX_LENGTH
} from '../agent-session-wire'

export const MAX_ID_LENGTH = AGENT_SESSION_ID_MAX_LENGTH

// Four Claude questions with all four generated choices occupy 610 chars when fully percent-encoded.
export const MAX_RESPONSE_OPTION_ID_LENGTH = 1024

export const MAX_PROMPT_BYTES = 256 * 1024

export const MAX_BLOCKS = 64

export const MAX_OPTION_LABEL = 512

/** One relaunch cannot offer more chats than a profile plausibly holds. */
export const MAX_RESTART_RESUME_SESSIONS = 512

export const SessionId = z
  .string()
  .max(MAX_ID_LENGTH)
  .refine(isAgentSessionId, 'Invalid agent session id')

export const Identifier = (message: string, maxLength = MAX_ID_LENGTH) =>
  z
    .string()
    .min(1, message)
    .max(maxLength, message)
    .refine((value) => value === value.trim(), message)

export const JournalCursor = z
  .object({
    epoch: Identifier('Invalid journal epoch'),
    sequence: z.number().int().nonnegative()
  })
  .strict()

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
    agent: z.enum(['claude', 'codex']),
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
    agent: z.enum(['claude', 'codex'])
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

export const RespondParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id'),
    /** Compare-and-set: the revision the client had on screen. */
    expectedRevision: z.number().int().positive(),
    optionId: Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH)
  })
  .strict()

export const SetOptionParams = z
  .object({
    envelope: MutationEnvelope,
    key: Identifier('Invalid option key'),
    value: z.string().max(MAX_OPTION_LABEL)
  })
  .strict()

export const OptionsParams = z.object({ sessionId: SessionId }).strict()

/** `sessionId` scopes the catalog to that session's pinned account; without a
 *  session record the host keys it by the account a new launch would pin.
 *  `worktree` names where a new chat runs, whose own config may replace the default. */
export const ModelCatalogParams = z.strictObject({
  agent: z.enum(['claude', 'codex']),
  sessionId: SessionId.optional(),
  worktree: Identifier('Invalid worktree selector').optional()
})

export const ConversationCommandParams = z
  .object({
    envelope: MutationEnvelope,
    command: z.enum(['clear', 'compact'])
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

export const HistoryParams = z
  .object({
    sessionId: SessionId,
    direction: z.enum(AGENT_SESSION_HISTORY_DIRECTIONS),
    cursor: JournalCursor.optional(),
    limit: z.number().int().positive().max(AGENT_SESSION_HISTORY_MAX_LIMIT).optional()
  })
  .strict()

export const SubscribeParams = z
  .object({ sessionId: SessionId, cursor: JournalCursor.optional() })
  .strict()

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
