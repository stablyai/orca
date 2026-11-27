import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { StructuredAgent } from '../structured-agent-session/structured-agent-session-params'

export const ManagedRuntimeAgentParams = lazyZodSchema(() =>
  z.strictObject({
    agent: StructuredAgent,
    /** The program the client showed; absent acts on the host's current choice. */
    program: z.enum(['cli', 'server']).optional()
  })
)

export const ManagedRuntimeCancelParams = lazyZodSchema(() =>
  z.strictObject({
    agent: StructuredAgent,
    operationId: z.string().min(1).max(64)
  })
)
