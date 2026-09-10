import { z } from 'zod'
import { AgentJournalItemBodySchema } from './agent-session-journal-schemas'
import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'

export const AGENT_SESSION_REWIND_REASONS = [
  'unsupported',
  'history-not-paginated',
  'busy',
  'stale-epoch',
  'invalid-target',
  'history-limit',
  'provider-refused',
  'proof-mismatch',
  'outcome-unknown'
] as const
export type AgentSessionRewindReason = (typeof AGENT_SESSION_REWIND_REASONS)[number]
export type AgentSessionRewindSupport =
  | { supported: true }
  | { supported: false; reason: AgentSessionRewindReason }
export type AgentSessionRewindParams = {
  envelope: AgentSessionMutationEnvelope
  itemId: string
  expectedEpoch: string
}
export type AgentSessionRewindResult = { itemId: string; epoch: string }

const Key = z.string().min(1).max(4096)
export const AgentSessionRewindRecordSchema = z.object({
  operationId: Key,
  callerKey: Key,
  itemId: Key,
  providerItemId: Key.optional(),
  expectedEpoch: Key,
  phase: z.enum(['prepared', 'provider-succeeded', 'completed', 'refused']),
  epoch: Key.optional(),
  hydrationVerified: z.boolean().optional(),
  providerApplied: z.boolean().optional(),
  reason: z.string().min(1).max(512).optional(),
  retained: z
    .array(
      z.object({
        itemId: Key.refine((key) => parseAgentJournalItemKey(key) !== null),
        body: AgentJournalItemBodySchema,
        observedAt: z.number().finite()
      })
    )
    .max(10_000)
})
export type AgentSessionRewindRecord = z.infer<typeof AgentSessionRewindRecordSchema>
export const isAgentSessionRewindRecord = (value: unknown): value is AgentSessionRewindRecord =>
  AgentSessionRewindRecordSchema.safeParse(value).success

export function isAgentSessionRewindResult(value: unknown): value is AgentSessionRewindResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const result = value as Partial<AgentSessionRewindResult>
  return typeof result.itemId === 'string' && typeof result.epoch === 'string'
}
