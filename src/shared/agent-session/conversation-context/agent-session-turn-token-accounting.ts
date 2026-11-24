import { z } from 'zod'

export const AgentSessionTurnTokenCountsSchema = z.strictObject({
  uncachedInput: z.number().int().nonnegative(),
  cacheReadInput: z.number().int().nonnegative(),
  cacheWriteInput: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoningOutputSubset: z.number().int().nonnegative().nullable()
})
export const AgentSessionTurnTokenAccountingSchema = z.strictObject({
  provider: z.enum(['claude', 'codex']),
  scope: z.literal('reported_root_turn'),
  tokens: AgentSessionTurnTokenCountsSchema.nullable(),
  previousTotals: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningOutputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative()
    })
    .optional()
})

export type AgentSessionTurnTokenCounts = {
  uncachedInput: number
  cacheReadInput: number
  cacheWriteInput: number
  output: number
  reasoningOutputSubset: number | null
}

export type AgentSessionTurnTokenAccounting = {
  provider: 'claude' | 'codex'
  scope: 'reported_root_turn'
  tokens: AgentSessionTurnTokenCounts | null
  previousTotals?: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    reasoningOutputTokens: number
    totalTokens: number
  }
}
