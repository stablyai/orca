import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { agentJournalSubmissionKey } from '../../journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../journal/agent-session-journal-types'
import {
  AGENT_SESSION_DISPATCH_LIMITS,
  type AgentSessionReceiptProvider
} from '../../journal/agent-session-dispatch-limits'
import type { StructuredAgentSessionState } from './structured-agent-session-reducer'

type Batch = Extract<AgentSessionSubscribeEvent, { type: 'batch' }>
type ReceiptState = Pick<
  StructuredAgentSessionState,
  'providerReceived' | 'pendingProviderAttempts'
>
export type PendingProviderAttempts = {
  bySequence: ReadonlyMap<number, string>
  byItem: ReadonlyMap<string, number>
}

export function isProviderReceiptOnly(event: AgentSessionSubscribeEvent): boolean {
  return (
    event.type === 'batch' &&
    !!event.providerReceived?.length &&
    !event.batch.items.length &&
    !event.batch.removedItemIds.length &&
    !event.batch.submissions.length &&
    Object.keys(event).length === 5
  )
}

export function applyProviderReceived(
  state: ReceiptState,
  stamps: readonly number[] | undefined,
  limit: number
): ReceiptState['providerReceived'] {
  const previous = state.providerReceived
  let next: Map<string, number> | undefined
  if (stamps && state.pendingProviderAttempts) {
    for (let index = 0; index < Math.min(stamps.length, limit); index++) {
      const sequence = stamps[index]!
      const itemId = state.pendingProviderAttempts.bySequence.get(sequence)
      if (!itemId || (next ?? previous)?.get(itemId) === sequence) {
        continue
      }
      if ((next ?? previous)?.size === limit) {
        break
      }
      next ??= new Map(previous)
      next.set(itemId, sequence)
    }
  }
  return next ?? previous
}

export function pruneProviderAttempts(
  state: ReceiptState,
  removed: Iterable<string>
): ReceiptState {
  const before = state.pendingProviderAttempts
  if (!before) {
    return { providerReceived: state.providerReceived }
  }
  let byItem: Map<string, number> | undefined
  let bySequence: Map<number, string> | undefined
  let received: Map<string, number> | undefined
  for (const itemId of removed) {
    const sequence = (byItem ?? before.byItem).get(itemId)
    if (sequence === undefined) {
      continue
    }
    byItem ??= new Map(before.byItem)
    bySequence ??= new Map(before.bySequence)
    byItem.delete(itemId)
    bySequence.delete(sequence)
    if (state.providerReceived?.has(itemId)) {
      received ??= new Map(state.providerReceived)
      received.delete(itemId)
    }
  }
  return {
    pendingProviderAttempts: byItem && bySequence ? { byItem, bySequence } : before,
    providerReceived: received ? (received.size ? received : undefined) : state.providerReceived
  }
}

export function providerAttemptsAfterBatch(
  state: ReceiptState,
  event: Batch,
  items: readonly AgentJournalRenderItem[],
  lost: readonly AgentJournalRenderItem[],
  provider: AgentSessionReceiptProvider
): ReceiptState {
  const previous = state.pendingProviderAttempts
  let touched: Set<string> | undefined
  let pending: Set<string> | undefined
  for (const submission of event.batch.submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (submission.dispatchState !== 'pending') {
      ;(touched ??= new Set()).add(id)
    } else if (submission.handedOverAt !== undefined) {
      ;(pending ??= new Set()).add(id)
    }
  }
  let candidates: Map<string, number> | undefined
  for (const item of items) {
    const { itemId, sequence } = item
    if (item.body.kind !== 'message' || item.body.role !== 'user') {
      continue
    }
    const before = previous?.byItem.get(itemId)
    if (before !== undefined && before !== sequence) {
      ;(touched ??= new Set()).add(itemId)
    }
    if (before !== sequence && pending?.has(itemId)) {
      ;(candidates ??= new Map()).set(itemId, sequence)
    }
  }
  for (const itemId of event.batch.removedItemIds) {
    ;(touched ??= new Set()).add(itemId)
    candidates?.delete(itemId)
  }
  for (const { itemId } of lost) {
    ;(touched ??= new Set()).add(itemId)
    candidates?.delete(itemId)
  }
  const next = touched ? pruneProviderAttempts(state, touched) : state
  const limit = AGENT_SESSION_DISPATCH_LIMITS[provider]
  let pendingProviderAttempts = next.pendingProviderAttempts
  if (candidates?.size && (pendingProviderAttempts?.byItem.size ?? 0) < limit) {
    const byItem = new Map(pendingProviderAttempts?.byItem)
    const bySequence = new Map(pendingProviderAttempts?.bySequence)
    for (const [id, sequence] of candidates) {
      if (byItem.size >= limit) {
        break
      }
      byItem.set(id, sequence)
      bySequence.set(sequence, id)
    }
    pendingProviderAttempts = { byItem, bySequence }
  }
  return {
    pendingProviderAttempts,
    providerReceived: applyProviderReceived(
      { ...next, pendingProviderAttempts },
      event.providerReceived,
      limit
    )
  }
}
