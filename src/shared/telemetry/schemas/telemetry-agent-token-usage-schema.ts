import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const tokenCount = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))

export const agentTokenCountsSchema = lazyZodSchema(() =>
  z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cached_input_tokens: tokenCount,
      cache_write_input_tokens: tokenCount
    })
    .strict()
)

const agentTokenProviderSchema = lazyZodSchema(() => z.enum(['claude', 'codex', 'opencode']))

/** Tokens one provider used on one local calendar day; later rows for the same day add growth found afterwards.
 *  Replaces per-session agent_token_usage snapshots: per install, use those only before its first daily row.
 *  Days an install spends on an older build that never upgrades again, or for over 30 days, are not covered. */
export const agentTokenUsageDailySchema = lazyZodSchema(() =>
  agentTokenCountsSchema
    .extend({
      provider: agentTokenProviderSchema,
      usage_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    })
    .strict()
)

export type AgentTokenCounts = z.infer<typeof agentTokenCountsSchema>
export type AgentTokenProvider = z.infer<typeof agentTokenProviderSchema>
export type AgentTokenUsageDaily = z.infer<typeof agentTokenUsageDailySchema>
