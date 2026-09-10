import { AGENT_SESSION_PREFIX_MAX_ENTRIES } from './agent-session-prefix-bounds'
import { z } from 'zod'
import { AgentJournalItemBodySchema } from './agent-session-journal-schemas'
import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import { isAgentSessionProviderHandle } from './agent-session-provider-handle'
import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink
} from './agent-session-provider-handle'

export type AgentSessionForkSource = {
  sessionId: string
  itemId: string
  expectedEpoch: string
  expectedRuntimeFence: number
}

export type AgentSessionForkTarget = {
  retainedItemIds?: readonly string[]
  source: AgentSessionProviderHandle
  throughId: string
}

const Key = z.string().min(1).max(4096)
export const AgentSessionForkRecordSchema = z.object({
  sourceSessionId: Key,
  operationId: Key,
  callerKey: Key,
  recoveryOperationId: Key.optional(),
  recoveryExpectedFence: z.number().int().positive().optional(),
  itemId: Key,
  expectedEpoch: Key,
  expectedRuntimeFence: z.number().int().positive(),
  source: z.custom<AgentSessionProviderHandle>(isAgentSessionProviderHandle),
  throughId: Key,
  /** `attempted` is the ambiguity guard: the provider may or may not hold a child, so it never
   *  retries. `refused` is its terminal counterpart for a failure that provably preceded any
   *  provider session, and is recoverable. */
  phase: z.enum(['prepared', 'attempted', 'provider-succeeded', 'completed', 'refused']),
  reason: z.string().min(1).max(512).optional(),
  retained: z
    .array(
      z.object({
        itemId: Key.refine((key) => parseAgentJournalItemKey(key) !== null),
        body: AgentJournalItemBodySchema,
        observedAt: z.number().finite()
      })
    )
    .max(AGENT_SESSION_PREFIX_MAX_ENTRIES)
})
export type AgentSessionForkRecord = z.infer<typeof AgentSessionForkRecordSchema>
export const isAgentSessionForkRecord = (value: unknown): value is AgentSessionForkRecord =>
  AgentSessionForkRecordSchema.safeParse(value).success

export function agentSessionForkAnchor(
  source: AgentSessionProviderHandle,
  fence: number,
  observedAt: number
): AgentSessionProviderHandleLink {
  return {
    linkId: 'fork-source',
    handle: source,
    origin: 'adopted',
    mintedAtFence: fence,
    observedAt
  }
}

export type AgentSessionForkSupport = { supported: true } | { supported: false; reason: string }
