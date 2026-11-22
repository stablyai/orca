import { z } from 'zod'

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const agentTokenCountsSchema = z
  .object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    cached_input_tokens: tokenCount,
    cache_write_input_tokens: tokenCount
  })
  .strict()

export const agentTokenUsageSchema = agentTokenCountsSchema
  .extend({
    provider: z.enum(['claude', 'codex', 'opencode']),
    analytics_session_id: z.uuidv4(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

/** Tokens one provider used on one local calendar day; later rows for the same day add growth found afterwards. */
export const agentTokenUsageDailySchema = agentTokenCountsSchema
  .extend({
    provider: agentTokenUsageSchema.shape.provider,
    usage_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  })
  .strict()

export type AgentTokenCounts = z.infer<typeof agentTokenCountsSchema>
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>
export type AgentTokenUsageDaily = z.infer<typeof agentTokenUsageDailySchema>
