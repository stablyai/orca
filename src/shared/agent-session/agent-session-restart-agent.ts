import { z } from 'zod'

export const RestartAgentParams = z
  .object({
    sessionId: z.string().min(1),
    /** Also stop background agents, commands and dispatches the running agent still owns. */
    force: z.boolean().optional()
  })
  .strict()

/** `background-work` is the only refusal a forced retry can pass. */
export type AgentSessionRestartAgentResult =
  | { restarted: true }
  | { restarted: false; reason: 'not-running' | 'busy' | 'background-work' }
