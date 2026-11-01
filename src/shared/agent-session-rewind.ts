import { z } from 'zod'
import {
  AgentJournalItemBodySchema,
  AgentJournalProducerLinkageFields,
  AgentJournalTurnScopeSchema
} from './agent-session-journal-schemas'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from './agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from './agent-session-queued-submission'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
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
export type AgentSessionRewindResult = {
  itemId: string
  epoch: string
  sequence?: number
}

const Key = z.string().min(1).max(4096)
export const AgentSessionRewindRecordSchema = z.object({
  operationId: Key,
  callerKey: Key,
  itemId: Key,
  providerItemId: Key.optional(),
  expectedEpoch: Key,
  contextClearOperationId: Key.optional(),
  contextClearSequence: z.number().int().positive().optional(),
  phase: z.enum(['prepared', 'provider-succeeded', 'completed', 'refused']),
  epoch: Key.optional(),
  sequence: z.number().int().nonnegative().optional(),
  /** Written by older builds only, as is `retained`: rewind now derives both from the journal. */
  hydrationVerified: z.boolean().optional(),
  // A provider that rewinds by forking: the session the chat continues in, copied from `sourceSessionId`
  // through `throughEntryId` (absent: nothing kept). Older records defer the copy to launch.
  providerFork: z
    .object({
      sessionId: Key,
      sourceSessionId: Key,
      throughEntryId: Key.optional(),
      materialized: z.boolean().optional(),
      resumeCursor: Key.optional(),
      // The chat's session when it was rewound; a later head means the fork no longer applies.
      replacesSessionId: Key
    })
    .optional(),
  reason: z.string().min(1).max(512).optional(),
  retained: z
    .array(
      z.object({
        itemId: Key.refine((key) => parseAgentJournalItemKey(key) !== null),
        body: AgentJournalItemBodySchema,
        observedAt: z.number().finite(),
        // Absent on records written before rows stated them: the rebuild then places the row by position.
        turnScope: AgentJournalTurnScopeSchema.optional(),
        // The row's execution provenance, carried into the rebuilt epoch. Absent on records written
        // before rows carried it.
        ownerFence: z.number().int().nonnegative().optional(),
        // The run executing a reusable child's row, kept apart from `ownerFence`. Absent on records
        // written before rows carried it.
        executionOwner: z.number().int().nonnegative().optional(),
        ...AgentJournalProducerLinkageFields
      })
    )
    .max(10_000)
    .optional()
})
export type AgentSessionRewindRecord = z.infer<typeof AgentSessionRewindRecordSchema>
export type AgentSessionRewindFork = NonNullable<AgentSessionRewindRecord['providerFork']>

// Accepted messages keep Orca's key until a rewind rebuilds the epoch with provider keys.
export function savedRewindKeys(submissions: readonly AgentJournalSubmission[]) {
  const providerKeys = new Map<string, string>()
  const omitted = new Set<string>()
  for (const submission of submissions) {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    providerKeys.set(key, key)
    if (isQueuedAgentJournalSubmission(submission) || submission.dispatchState === 'rejected') {
      omitted.add(key)
    } else if (submission.dispatchState === 'accepted' && submission.providerItemId) {
      providerKeys.set(key, submission.providerItemId)
    }
  }
  const providerKey = (itemId: string) => providerKeys.get(itemId) ?? itemId
  return {
    providerKey,
    omitted,
    hasSubmission: (itemId: string) => providerKeys.has(itemId),
    nativeIdentity: (itemId: string) => {
      const key = parseAgentJournalItemKey(providerKey(itemId))
      return key?.provider === 'claude' || key?.provider === 'codex' ? key : null
    }
  }
}

/** Rewind whole turns only: mid-turn sends have different provider/journal order. Read turnOpener from the turn record, matching restored-history scope. */
export function isAgentSessionRewindTarget(
  item: Pick<AgentJournalRenderItem, 'itemId' | 'body' | 'turnScope'>,
  turnOpener: (turnItemId: string) => string | undefined
): boolean {
  if (item.body.kind !== 'message' || item.body.role !== 'user') {
    return false
  }
  return (
    item.turnScope?.kind !== 'unknown' &&
    (item.turnScope?.kind !== 'turn' || turnOpener(item.turnScope.turnItemId) === item.itemId)
  )
}

/** Apply the owed fork while the head is the rewound session or its unwritten fork. Include prepared recovery so early launch cannot resume the old conversation. */
export function pendingAgentSessionRewindFork(
  rewind: AgentSessionRewindRecord | undefined,
  headNativeId: string | undefined
): AgentSessionRewindFork | null {
  const fork = rewind?.providerFork
  if (!fork || rewind.phase === 'refused') {
    return null
  }
  return headNativeId === fork.replacesSessionId || headNativeId === fork.sessionId ? fork : null
}
export const isAgentSessionRewindRecord = (value: unknown): value is AgentSessionRewindRecord =>
  AgentSessionRewindRecordSchema.safeParse(value).success

export function isAgentSessionRewindResult(value: unknown): value is AgentSessionRewindResult {
  if (!value || typeof value !== 'object') {
    return false
  }
  const result = value as Partial<AgentSessionRewindResult>
  return typeof result.itemId === 'string' && typeof result.epoch === 'string'
}
