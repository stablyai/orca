import { z } from 'zod'
import { StructuredAgent } from './structured-agent-session-params'

export const ManagedRuntimeAgentParams = z.strictObject({ agent: StructuredAgent })

export const ManagedRuntimeCancelParams = z.strictObject({
  agent: StructuredAgent,
  operationId: z.string().min(1).max(64)
})
