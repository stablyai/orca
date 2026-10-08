// Admission for the context facts a turn row carries. Bounded to what the
// writer can produce, so a replayed row can never hold more than a live one.

import { z } from 'zod'
import {
  MAX_CONTEXT_CATEGORIES,
  MAX_CONTEXT_CATEGORY_NAME_CHARS,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextUsage
} from './agent-session-context-usage'

const TokenCount = z.number().finite().nonnegative()
const WindowTokens = z.number().finite().positive()
const CapturedAt = z.number().finite()
const ModelId = z.string().min(1).max(MAX_CONTEXT_MODEL_ID_CHARS)

const TokenUsage = z.object({
  inputTokens: TokenCount,
  cacheCreationInputTokens: TokenCount,
  cacheReadInputTokens: TokenCount,
  outputTokens: TokenCount
})

const Used = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('report'),
    model: ModelId,
    usedTokens: TokenCount,
    windowTokens: WindowTokens,
    percentage: z.number().finite(),
    autoCompactAtTokens: TokenCount.optional(),
    categories: z
      .array(
        z.object({
          name: z.string().min(1).max(MAX_CONTEXT_CATEGORY_NAME_CHARS),
          tokens: TokenCount,
          deferred: z.literal(true).optional()
        })
      )
      .max(MAX_CONTEXT_CATEGORIES),
    capturedAt: CapturedAt
  }),
  z.object({ kind: z.literal('estimate'), usage: TokenUsage, capturedAt: CapturedAt }),
  z.object({ kind: z.literal('unknown'), capturedAt: CapturedAt })
])

export const AgentSessionContextUsageSchema = z.object({
  window: z.object({ tokens: WindowTokens, capturedAt: CapturedAt }).optional(),
  used: Used.optional()
})

export function isAdmissibleAgentSessionContextUsage(
  value: unknown
): value is AgentSessionContextUsage {
  return AgentSessionContextUsageSchema.safeParse(value).success
}

type Admits<T extends true> = T
export type CanonicalContextUsageIsAdmissible = Admits<
  AgentSessionContextUsage extends z.input<typeof AgentSessionContextUsageSchema> ? true : false
>
