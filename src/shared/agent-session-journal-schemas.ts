// ─── Canonical runtime schemas for the journal render model ─────────────────
// The journal admits JSON it did not just write — snapshot files and log rows
// re-enter from disk and are republished to clients — while the reducer, the
// shared projection, and the prompt surfaces dereference nested fields without
// guards. These schemas are the single deep validators for that render model:
// admission must reject a JSON-valid but structurally wrong item (a question
// whose `options` are null, a prompt without its `resolution`) so corruption
// lands in quarantine instead of throwing mid-render.
//
// Discriminants (`kind`, known block `type`s) are validated deeply. Open string
// fields (roles, dispatch/tool states) stay type-checked, never enum-checked,
// and unknown object keys pass — a same-version row written by a slightly
// newer build must not be misread as malformed (see journal-row-schema.ts).

import { z } from 'zod'
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

const KNOWN_BLOCK_TYPES = new Set(['text', 'tool-call', 'tool-result', 'image-ref'])

/** Renderers select blocks by `type` equality and skip what they cannot draw,
 *  so an unknown block type stays admissible; a known type with a broken
 *  payload does not. */
const Block = z.union([
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      text: z.string(),
      providerFrame: ProviderFrame.optional()
    }),
    // `input: undefined` loses its key under JSON.stringify, so a persisted
    // canonical tool call may lack it entirely.
    z.object({ type: z.literal('tool-call'), name: z.string(), input: z.unknown().optional() }),
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
    })
  ]),
  z.object({ type: z.string() }).refine((block) => !KNOWN_BLOCK_TYPES.has(block.type))
])

const PromptOption = z.object({ id: z.string(), label: z.string() })

const Resolution = z.object({
  state: z.string().min(1),
  selectedOptionId: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable()
})

const MessageBody = z.object({
  kind: z.literal('message'),
  role: z.string().min(1),
  blocks: z.array(Block)
})

export const AgentJournalItemBodySchema = z.discriminatedUnion('kind', [
  MessageBody,
  z.object({
    kind: z.literal('tool-call'),
    name: z.string(),
    // See the tool-call block: the key itself is lost when `input` is undefined.
    input: z.unknown().optional(),
    state: z.string().min(1),
    output: BoundedPayload.optional()
  }),
  z.object({ kind: z.literal('diff'), path: z.string(), patch: BoundedPayload }),
  z.object({
    kind: z.literal('approval'),
    title: z.string(),
    detail: z.string().nullable(),
    options: z.array(PromptOption),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('question'),
    question: z.string(),
    options: z.array(PromptOption),
    freeTextQuestionId: z.string().optional(),
    resolution: Resolution
  }),
  z.object({
    kind: z.literal('status'),
    text: z.string(),
    turnLifecycle: z.object({ turnId: z.string(), state: z.string().min(1) }).optional(),
    providerFrame: ProviderFrame.optional()
  })
])

export const AgentJournalRenderItemSchema = z.object({
  itemId: z.string().min(1),
  revision: z.number().int(),
  body: AgentJournalItemBodySchema,
  sequence: z.number().int(),
  observedAt: z.number(),
  recovered: z.literal(true).optional()
})

export const AgentJournalSubmissionSchema = z.object({
  clientMessageId: z.string().min(1),
  fence: z.number().int(),
  payloadFingerprint: z.string(),
  dispatchState: z.string().min(1),
  providerItemId: z.string().nullable(),
  reason: z.string().nullable(),
  submittedAt: z.number(),
  resolvedAt: z.number().nullable()
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

/** Compile-time proof that every canonical value is admissible, so admission
 *  can never quarantine a row a writer in this build produced. The schemas are
 *  deliberately wider on open string fields, so only this direction holds. */
type Admits<T extends true> = T
export type CanonicalJournalShapesAreAdmissible = [
  Admits<AgentJournalItemBody extends z.input<typeof AgentJournalItemBodySchema> ? true : false>,
  Admits<AgentJournalMessageItem extends z.input<typeof MessageBody> ? true : false>,
  Admits<
    AgentJournalRenderItem extends z.input<typeof AgentJournalRenderItemSchema> ? true : false
  >,
  Admits<AgentJournalSubmission extends z.input<typeof AgentJournalSubmissionSchema> ? true : false>
]
