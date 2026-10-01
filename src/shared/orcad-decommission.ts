/** What a client learns from decommissioning a managed orcad. */
import { z } from 'zod'

export const OrcadDecommissionResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('decommissioned'),
    version: z.string().min(1).max(255),
    /** The daemon's fate: `retired`, or kept with its terminals (`live`/`unverifiable`). */
    retirement: z.enum(['retired', 'live', 'unverifiable'])
  }),
  z.object({
    outcome: z.literal('refused'),
    verdict: z.enum(['live', 'unverifiable']),
    code: z.string(),
    reason: z.string()
  })
])

export type OrcadDecommissionResult = z.infer<typeof OrcadDecommissionResultSchema>
