import { z } from 'zod'

/** Freeze choices on acceptance; permission stays a launch setting. Strip unknown keys from free-form send/saved options. */
export const AgentSessionExecutionOptionsSchema = z.object({
  model: z.string().min(1).max(256).optional(),
  effort: z.string().min(1).max(64).optional(),
  personality: z.string().min(1).max(64).optional(),
  fastMode: z.enum(['true', 'false']).optional(),
  serviceTier: z.string().min(1).max(64).optional()
})

export type AgentSessionExecutionOptions = z.infer<typeof AgentSessionExecutionOptionsSchema>

/** The one read of a message's `options` record, from a send or a saved row. */
export function readAgentSessionExecutionOptions(
  value: unknown
): AgentSessionExecutionOptions | null {
  const parsed = AgentSessionExecutionOptionsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The `options` record a send and a saved row carry for these choices. */
export function agentSessionExecutionOptionsRecord(
  options: AgentSessionExecutionOptions
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(options).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/** Exact picker domain; personality remains host-captured. */
export const AgentSessionSelectionSchema = AgentSessionExecutionOptionsSchema.omit({
  personality: true
}).strict()
