import * as z from 'zod'

/** Why the agent couldn't do what was asked, from its own typed signals (unconfirmed: lost across a
 *  restart); a cloud that predates it drops it, and one that doesn't know the category reads it as
 *  agent_error. */
export const CONNECTOR_FAILURE_CATEGORIES = [
  'signed_out',
  'usage_limit',
  'not_set_up',
  'folder_missing',
  'agent_error',
  'unconfirmed'
] as const
export type ConnectorFailureCategory = (typeof CONNECTOR_FAILURE_CATEGORIES)[number]

export const ConnectorFailure = z.object({
  category: z.enum(CONNECTOR_FAILURE_CATEGORIES),
  /** The agent's display name, e.g. "Codex". */
  agentName: z.string().optional(),
  /** Only what the agent said: which limit, and when it resets (epoch ms). */
  usageLimit: z
    .object({ window: z.string().optional(), resetsAt: z.number().optional() })
    .optional(),
  /** This machine's IANA time zone, for sources that can't show a time in each reader's clock. */
  timeZone: z.string().optional()
})
export type ConnectorFailure = z.infer<typeof ConnectorFailure>
