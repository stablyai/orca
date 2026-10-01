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

export type AgentTokenCounts = z.infer<typeof agentTokenCountsSchema>
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>
