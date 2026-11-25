import { z } from 'zod'
import { StructuredAgent } from '../structured-agent-session/structured-agent-session-params'

export const ManagedRuntimeAgentParams = z.strictObject({
  agent: StructuredAgent,
  /** The program the client showed; absent acts on the host's current choice. */
  program: z.enum(['cli', 'server']).optional()
})

export const ManagedRuntimeCancelParams = z.strictObject({
  agent: StructuredAgent,
  operationId: z.string().min(1).max(64)
})
