import * as z from 'zod'

/** Provider output tokens over measured model-request time, including TTFT; excludes tool execution. */
export const AgentSessionGenerationUsageSchema = z.object({
  outputTokens: z.number().finite().nonnegative(),
  durationMs: z.number().finite().positive()
})

export type AgentSessionGenerationUsage = z.infer<typeof AgentSessionGenerationUsageSchema>

export function agentSessionTokensPerSecond(
  usage: AgentSessionGenerationUsage | null | undefined
): number | null {
  return usage && usage.outputTokens > 0 && usage.durationMs >= 100
    ? (usage.outputTokens * 1000) / usage.durationMs
    : null
}
