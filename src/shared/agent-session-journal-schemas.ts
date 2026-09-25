// ─── Canonical runtime schemas for the journal render model ─────────────────
// The journal admits JSON it did not just write — persisted rows re-enter from
// SQLite on replay and are republished to clients — while the reducer, the
// shared projection, and the prompt surfaces dereference nested fields without
// guards. These schemas are the single deep validators for that render model:
// admission must reject a JSON-valid but structurally wrong item (a question
// whose `options` are null, a prompt without its `resolution`) so the row is
// rejected at replay, where a repair can delete it, instead of throwing
// mid-render.
//
// Discriminants (`kind`, known block `type`s) are validated deeply. Open string
// fields (roles, dispatch/tool states) stay type-checked, never enum-checked,
// and unknown object keys pass — a same-version row written by a slightly
// newer build must not be misread as malformed (see journal-row-schema.ts).

import { z } from 'zod'
import { AgentSessionContextUsageSchema } from './agent-session-context-usage-schema'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'

const BoundedPayload = z.object({
  head: z.string(),
  byteLength: z.number(),
  digest: z.string(),
  truncated: z.boolean()
})

const ProviderFrame = z.object({
  provider: z.string(),
  kind: z.string(),
  payload: BoundedPayload
})

const ToolMetadata = {
  mcpIdentity: z.object({ server: z.string(), tool: z.string() }).optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  webSearchResults: z.array(z.object({ title: z.string(), url: z.string() })).optional()
}

const KNOWN_BLOCK_TYPES = new Set([
  'text',
  'tool-call',
  'tool-result',
  'image-ref',
  'subagent-group',
  'background-task'
])

/** Provider IDs are opaque; reject all-whitespace values without rewriting valid IDs. */
const ProviderCallId = z
  .string()
  .refine((value) => value.trim().length > 0, 'callId must contain a non-whitespace character')

/** Child-agent lifecycle stays an open string for the same reason tool states
 *  do: a state a newer build writes must not turn the row malformed. */
const SubagentEntry = z.object({
  id: z.string(),
  label: z.string(),
  state: z.string().min(1),
  tokens: z.number().optional(),
  startedAt: z.number().optional(),
  settledAt: z.number().optional()
})

/** Renderers select blocks by `type` equality and skip what they cannot draw,
 *  so an unknown block type stays admissible; a known type with a broken
 *  payload does not. */
const Block = z.union([
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: z.string(),
      presentation: z.string().optional(),
      tone: z.string().optional(),
      providerFrame: ProviderFrame.optional()
    }),
    // `input: undefined` loses its key under JSON.stringify, so a persisted
    // canonical tool call may lack it entirely.
    z.object({
      type: z.literal('tool-call'),
      name: z.string(),
      input: z.unknown().optional(),
      callId: ProviderCallId.optional(),
      ...ToolMetadata
    }),
    z.object({
      type: z.literal('tool-result'),
      output: z.string(),
      isError: z.boolean().optional()
    }),
    z.object({
      type: z.literal('image-ref'),
      path: z.string().optional(),
      url: z.string().optional(),
      alt: z.string().optional()
    }),
    z.object({
      type: z.literal('subagent-group'),
      groupId: z.string(),
      agents: z.array(SubagentEntry)
    }),
    // `kind` and `state` stay open strings for the same reason a child's
    // lifecycle does: a vocabulary a newer build writes must not turn the row
    // malformed. The renderer falls back on anything it cannot name.
    z.object({
      type: z.literal('background-task'),
      taskId: z.string().min(1),
      kind: z.string().min(1),
      label: z.string(),
      state: z.string().min(1),
      parentToolUseId: z.string().optional(),
      summary: z.string().optional(),
      error: z.string().optional(),
      outputFile: z.string().optional(),
      tokens: z.number().optional(),
      startedAt: z.number().optional(),
      settledAt: z.number().optional()
    })
  ]),
  z.object({ type: z.string() }).refine((block) => !KNOWN_BLOCK_TYPES.has(block.type))
])

const PromptOption = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional()
  })
  .strict()

const Question = z
  .object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    multiSelect: z.boolean(),
    options: z.array(PromptOption),
    freeTextQuestionId: z.string().optional()
  })
  .strict()

const Resolution = z.object({
  state: z.string().min(1),
  selectedOptionId: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable()
})

const ApprovalMatchedAskRule = z.object({
  source: z.string(),
  toolName: z.string(),
  ruleContent: z.string().optional()
})

const ApprovalSubject = z.object({
  kind: z.literal('plan'),
  text: z.string().min(1),
  filePath: z.string().optional()
})

const MessageBody = z.object({
  kind: z.literal('message'),
  role: z.string().min(1),
  blocks: z.array(Block),
  // Open like roles: a send mode a newer build writes must not turn the row malformed.
  sentAs: z.string().min(1).optional()
})

const ThreadGoal = z.object({
  objective: z.string(),
  status: z.string().min(1),
  tokenBudget: z.number().finite().nullable(),
  tokensUsed: z.number().finite(),
  timeUsedSeconds: z.number().finite(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite()
})

/** Like blocks: an unknown `state` stays admissible, a known one with a broken payload does not. */
const ThreadGoalState = z.union([
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), goal: ThreadGoal }),
    z.object({ state: z.literal('cleared') })
  ]),
  z.object({ state: z.string() }).refine((value) => !['set', 'cleared'].includes(value.state))
])

export const AgentJournalItemBodySchema = z.discriminatedUnion('kind', [
  MessageBody,
  z.object({
    kind: z.literal('tool-call'),
    ...ToolMetadata,
    name: z.string(),
    // See the tool-call block: the key itself is lost when `input` is undefined.
    input: z.unknown().optional(),
    callId: ProviderCallId.optional(),
    state: z.string().min(1),
    output: BoundedPayload.optional()
  }),
  z.object({ kind: z.literal('diff'), path: z.string(), patch: BoundedPayload }),
  z.object({
    kind: z.literal('approval'),
    title: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    decisionReason: z.string().optional(),
    blockedPath: z.string().optional(),
    matchedAskRule: ApprovalMatchedAskRule.optional(),
    subject: ApprovalSubject.optional(),
    detail: z.string().nullable(),
    options: z.array(PromptOption),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('question'),
    question: z.string(),
    options: z.array(PromptOption),
    questions: z.array(Question).optional(),
    freeTextQuestionId: z.string().optional(),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('status'),
    text: z.string(),
    presentation: z.string().optional(),
    tone: z.string().optional(),
    turnLifecycle: z
      .object({
        turnId: z.string(),
        state: z.string().min(1),
        outcome: z.string().min(1).optional(),
        userItemId: z.string().min(1).optional(),
        startedAt: z.number().finite().positive().optional(),
        requestedAt: z.number().finite().positive().optional(),
        completedAt: z.number().finite().positive().optional(),
        durationMs: z.number().finite().nonnegative().optional()
      })
      .optional(),
    providerFrame: ProviderFrame.optional(),
    threadGoal: ThreadGoalState.optional()
  }),
  z.object({
    kind: z.literal('turn'),
    turnId: z.string(),
    state: z.string().min(1),
    // Open like `state`: a verdict a newer build writes must not turn the row
    // malformed. `readAgentJournalTurnOutcome` is where an unplaceable one
    // becomes unknown rather than an arm a caller would act on.
    outcome: z.string().min(1).optional(),
    userItemId: z.string().min(1).optional(),
    startedAt: z.number().finite().positive().optional(),
    requestedAt: z.number().finite().positive().optional(),
    completedAt: z.number().finite().positive().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    contextUsage: AgentSessionContextUsageSchema.optional()
  })
])

/** Producer linkage as it rides a render item across the process boundary.
 *  `producerKind` stays an open string for the reason the header gives: a host
 *  that learns a third kind must not make its rows unreadable to this client. */
export const AgentJournalProducerLinkageFields = {
  // `.min(1)` on every id: an EMPTY string is present, and the reader that
  // scopes a parent's surfaces tests presence, not truthiness. `agentId: ''`
  // would read as a subagent and hide the row from its own author for good.
  agentId: z.string().min(1).optional(),
  parentAgentId: z.string().min(1).optional(),
  providerParentRef: z.string().min(1).optional(),
  producerKind: z.string().min(1).optional(),
  attempt: z.number().int().optional()
} as const

export const AgentJournalRenderItemSchema = z.object({
  itemId: z.string().min(1),
  revision: z.number().int(),
  body: AgentJournalItemBodySchema,
  sequence: z.number().int(),
  observedAt: z.number(),
  recovered: z.literal(true).optional(),
  recoveredAt: z.number().optional(),
  ...AgentJournalProducerLinkageFields
})

export const AgentJournalSubmissionSchema = z.object({
  clientMessageId: z.string().min(1),
  fence: z.number().int(),
  payloadFingerprint: z.string(),
  dispatchState: z.string().min(1),
  providerItemId: z.string().nullable(),
  reason: z.string().nullable(),
  submittedAt: z.number(),
  resolvedAt: z.number().nullable(),
  recovered: z.literal(true).optional()
})

export function isAdmissibleAgentJournalItemBody(value: unknown): value is AgentJournalItemBody {
  return AgentJournalItemBodySchema.safeParse(value).success
}

/** Submission rows may only carry a user-authored message body. */
export function isAdmissibleAgentJournalMessageBody(
  value: unknown
): value is AgentJournalMessageItem {
  return MessageBody.safeParse(value).success
}

export function isAdmissibleAgentJournalRenderItem(
  value: unknown
): value is AgentJournalRenderItem {
  return AgentJournalRenderItemSchema.safeParse(value).success
}

export function isAdmissibleAgentJournalSubmission(
  value: unknown
): value is AgentJournalSubmission {
  return AgentJournalSubmissionSchema.safeParse(value).success
}

/** Compile-time proof that every canonical value is admissible, so replay can
 *  never reject a row a writer in this build produced. The schemas are
 *  deliberately wider on open string fields, so only this direction holds. */
type Admits<T extends true> = T
export type CanonicalJournalTypesAreAdmissible = [
  Admits<AgentJournalItemBody extends z.input<typeof AgentJournalItemBodySchema> ? true : false>,
  Admits<AgentJournalMessageItem extends z.input<typeof MessageBody> ? true : false>,
  Admits<
    AgentJournalRenderItem extends z.input<typeof AgentJournalRenderItemSchema> ? true : false
  >,
  Admits<AgentJournalSubmission extends z.input<typeof AgentJournalSubmissionSchema> ? true : false>
]
