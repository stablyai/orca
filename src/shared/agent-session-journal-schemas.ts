// Validate replayed JSON deeply before unguarded reducers/renderers read it; malformed rows fail load without deletion.
// Extend with keys, open-union tags or a new row v; never tighten existing types/bounds/closed sets.
// Unknown keys and string vocabularies survive; unknown bodies/blocks/goals/subjects remain undrawn and writable.
// Unreadable context usage alone is dropped (journal-row-unusable-annotations.ts).
// Older rewind replaces unknown turn/tool/resolution states with placeholders and blocks with raw-JSON text, retaining unknown bodies.
// History pages lack row v: extensions must also remain safe for older clients (journal-closed-sets.test.ts).

import { z } from 'zod'
import { AgentSessionContextUsageSchema } from './agent-session-context-usage-schema'
import { AgentJournalThreadGoalStateSchema } from './agent-session-journal-thread-goal-schema'
import { AgentSessionFailureFactSchema } from './agent-session-failure-fact-schema'
import { knownTags, openDiscriminatedUnion } from './agent-session-journal-open-union'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalResolution,
  AgentJournalRenderItem
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

/** Provider IDs are opaque; reject all-whitespace values without rewriting valid IDs. */
const ProviderCallId = z
  .string()
  .refine((value) => value.trim().length > 0, 'callId must contain a non-whitespace character')

/** Keep lifecycle strings open so newer states do not make persisted rows malformed. */
const SubagentEntry = z.object({
  id: z.string(),
  label: z.string(),
  state: z.string().min(1),
  tokens: z.number().optional(),
  startedAt: z.number().optional(),
  settledAt: z.number().optional()
})

/** Skip unknown block types, but reject malformed payloads of known types. */
const Block = openDiscriminatedUnion(
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: z.string(),
      presentation: z.string().optional(),
      tone: z.string().optional(),
      providerFrame: ProviderFrame.optional()
    }),
    // JSON.stringify drops input: undefined, so persisted canonical calls may omit it.
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
    // `outcomeBasis` and `background` stay open for the same reason `state` does.
    SubagentEntry.extend({
      type: z.literal('subagent'),
      groupId: z.string(),
      parentId: z.string().optional(),
      run: z.string().optional(),
      outcomeBasis: z.string().optional(),
      background: z.boolean().optional()
    }),
    // Keep kind/state open for newer vocabularies; renderers fall back on unknown values.
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
  ])
)

const PromptOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional()
})

const FreeTextInput = z.object({
  allowEmpty: z.boolean().optional(),
  multiline: z.boolean().optional(),
  initialValue: z.string().optional(),
  placeholder: z.string().optional()
})

const Question = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  multiSelect: z.boolean(),
  options: z.array(PromptOption),
  freeTextQuestionId: z.string().optional(),
  freeTextInput: FreeTextInput.optional()
})

const Resolution = z.object({
  state: z.string().min(1),
  selectedOptionId: z.string().nullable(),
  answers: z
    .array(
      z.object({
        questionId: z.string(),
        optionIds: z.array(z.string()),
        other: z.string().optional()
      })
    )
    .optional(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable()
})

const ApprovalMatchedAskRule = z.object({
  source: z.string(),
  toolName: z.string(),
  ruleContent: z.string().optional()
})

const KnownApprovalSubject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), text: z.string().min(1), filePath: z.string().optional() })
])
export const AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS = knownTags(KnownApprovalSubject)
/** Open like blocks; a subject this build cannot draw is never approvable here
 *  (agent-session-approval-subject.ts). */
const ApprovalSubject = openDiscriminatedUnion(KnownApprovalSubject)

const MessageBody = z.object({
  kind: z.literal('message'),
  role: z.string().min(1),
  blocks: z.array(Block),
  // Open like roles: a send mode a newer build writes must not turn the row malformed.
  sentAs: z.string().min(1).optional(),
  command: z.object({ name: z.string().min(1) }).optional(),
  skills: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).optional(),
  // Open like `sentAs`: a state a newer host writes reads as completed, never malformed.
  state: z.string().min(1).optional(),
  completedAt: z.number().finite().optional()
})

/** A turn's lifecycle, as the turn item and the legacy status row both carry it. */
const TurnLifecycleFields = {
  turnId: z.string(),
  state: z.string().min(1),
  // Keep newer verdicts readable; readAgentJournalTurnOutcome maps unplaceable ones to unknown.
  outcome: z.string().min(1).optional(),
  userItemId: z.string().min(1).optional(),
  startedAt: z.number().finite().positive().optional(),
  requestedAt: z.number().finite().positive().optional(),
  completedAt: z.number().finite().positive().optional(),
  durationMs: z.number().finite().nonnegative().optional()
}

const KnownItemBody = z.discriminatedUnion('kind', [
  MessageBody,
  z.object({
    kind: z.literal('tool-call'),
    ...ToolMetadata,
    name: z.string(),
    // See the tool-call block: the key itself is lost when `input` is undefined.
    input: z.unknown().optional(),
    callId: ProviderCallId.optional(),
    state: z.string().min(1),
    // Open like `state`: an ending a newer build writes reads as the `state` beside it.
    endedAs: z.string().min(1).optional(),
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
    freeTextInput: FreeTextInput.optional(),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('status'),
    text: z.string(),
    presentation: z.string().optional(),
    contextClear: z
      .object({
        operationId: z.string().min(1).max(512),
        afterFence: z.number().int().nonnegative(),
        clearedAt: z.number().int().nonnegative()
      })
      .optional(),
    tone: z.string().optional(),
    turnLifecycle: z.object(TurnLifecycleFields).optional(),
    providerFrame: ProviderFrame.optional(),
    threadGoal: AgentJournalThreadGoalStateSchema.optional(),
    failure: AgentSessionFailureFactSchema.optional(),
    orcaStop: z.object({ cause: z.string().min(1) }).optional()
  }),
  z.object({
    kind: z.literal('turn'),
    ...TurnLifecycleFields,
    contextUsage: AgentSessionContextUsageSchema.optional(),
    providerTurnId: z.string().min(1).optional()
  })
])

/** Every body kind this build knows; a body of another kind is kept as-is and drawn by nobody. */
export const AGENT_JOURNAL_ITEM_BODY_KINDS = knownTags(KnownItemBody)
export const AgentJournalItemBodySchema = openDiscriminatedUnion(KnownItemBody)

/** Keep producerKind open so newer producer types remain readable across the wire. */
export const AgentJournalProducerLinkageFields = {
  // Empty IDs count as present and would permanently hide a parent's own row from parent-scoped readers.
  agentId: z.string().min(1).optional(),
  parentAgentId: z.string().min(1).optional(),
  providerParentRef: z.string().min(1).optional(),
  producerKind: z.string().min(1).optional(),
  attempt: z.number().int().optional()
} as const

/** Preserve unknown scope kinds from newer hosts without claiming a turn boundary or rejecting their content. */
export const AgentJournalTurnScopeSchema = z.object({
  kind: z.string().min(1),
  turnItemId: z.string().min(1).optional()
})

export const AgentJournalRenderItemSchema = z.object({
  itemId: z.string().min(1),
  revision: z.number().int(),
  body: AgentJournalItemBodySchema,
  sequence: z.number().int(),
  sequenceIndex: z.number().int().nonnegative().optional(),
  observedAt: z.number(),
  recovered: z.literal(true).optional(),
  recoveredAt: z.number().optional(),
  turnScope: AgentJournalTurnScopeSchema.optional(),
  shortened: z.literal(true).optional(),
  ...AgentJournalProducerLinkageFields
})

export function isAgentJournalResolution(value: unknown): value is AgentJournalResolution {
  return Resolution.safeParse(value).success
}

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

/** Prove canonical writes are admissible on replay; open-string schemas are deliberately wider, so the converse need not hold. */
type Admits<T extends true> = T
export type CanonicalJournalTypesAreAdmissible = [
  Admits<AgentJournalItemBody extends z.input<typeof AgentJournalItemBodySchema> ? true : false>,
  Admits<AgentJournalMessageItem extends z.input<typeof MessageBody> ? true : false>,
  Admits<AgentJournalRenderItem extends z.input<typeof AgentJournalRenderItemSchema> ? true : false>
]
