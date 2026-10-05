import { z } from 'zod'

export const BoundedPayload = z.object({
  head: z.string(),
  byteLength: z.number(),
  digest: z.string(),
  truncated: z.boolean()
})

export const ProviderFrame = z.object({
  provider: z.string(),
  kind: z.string(),
  payload: BoundedPayload
})

/** The journal's prose block. Unknown keys pass (see agent-session-journal-schemas.ts). */
export const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
  presentation: z.string().optional(),
  tone: z.string().optional(),
  providerFrame: ProviderFrame.optional(),
  // Not validated here: rejecting a row for an annotation truncates the journal from it.
  // The host reads it through readNativeChatMessageAsyncQuestions when deriving.
  asyncQuestions: z.unknown().optional()
})
