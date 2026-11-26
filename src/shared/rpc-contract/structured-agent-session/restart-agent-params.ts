import { z } from 'zod'

export const RestartAgentParams = z.object({ sessionId: z.string().min(1) }).strict()

/** `busy`: the agent kept its work and still runs; `stopped`: the next send starts a new one. */
export type RestartAgentOutcome = 'stopped' | 'busy' | 'not-running'
