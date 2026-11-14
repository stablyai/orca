import { z } from 'zod'
import type { agentSessionExecutionReceiptSchema } from './agent-session-execution-receipt'
import {
  agentSessionExecutionEvidenceSchema,
  agentSessionExecutionUsageSchema
} from './agent-session-execution-evidence'

// A primary-thread counter is not a bill or proof of auxiliary-request coverage.
export const agentSessionUsageMeterSchema = agentSessionExecutionEvidenceSchema
  .pick({
    version: true,
    agent: true,
    modelProvider: true,
    sessionId: true,
    runtimeFence: true,
    acquisitionGeneration: true,
    observedAt: true,
    model: true,
    effort: true,
    account: true
  })
  .extend({
    meterId: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.literal('primary-thread'),
    quiescent: z.literal(true),
    origin: z.enum(['fresh-thread', 'provider-counter']),
    usage: agentSessionExecutionUsageSchema
  })
  .strict()

export type AgentSessionUsageMeter = z.infer<typeof agentSessionUsageMeterSchema>

export type AgentSessionUsageSnapshot =
  | {
      status: 'ok'
      runtime: NonNullable<z.infer<typeof agentSessionExecutionReceiptSchema>['runtime']>
      meter: AgentSessionUsageMeter
    }
  | {
      status: 'unknown'
      reason: 'unsupported' | 'runtimeUnknown' | 'notHeld' | 'unavailableOrChanged'
    }
