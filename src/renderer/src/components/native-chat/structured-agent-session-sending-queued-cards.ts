import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { handedOffQueuedMessageIds } from '../../../../shared/structured-agent-session-draft-hand-off'
import {
  queuedMessageCardImages,
  queuedMessageCardText,
  type QueuedMessageCard
} from '../../../../shared/structured-agent-session-queued-cards'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

export function sendingQueuedMessageCards(
  entries: readonly StructuredAgentSessionPendingSend[]
): QueuedMessageCard[] {
  return entries.map((entry, index) => ({
    messageId: entry.clientMessageId,
    // After every card the host holds, in send order.
    position: Number.MAX_SAFE_INTEGER - entries.length + index,
    text: queuedMessageCardText(entry.body),
    ...queuedMessageCardImages(entry.body),
    state: 'waiting',
    hold: 'sending'
  }))
}

/** Host-owned cards and active queue requests stay out of transcript echoes; recorded sends remain until their row arrives. */
export function pendingSendsOutsideQueuedCards<
  Send extends { clientMessageId: string; delivery?: 'queue-if-active' }
>(pending: readonly Send[], heldIds: readonly string[], isWorking: boolean): readonly Send[] {
  const held = new Set(heldIds)
  const next = pending.filter(
    (entry) =>
      !held.has(entry.clientMessageId) && !(isWorking && entry.delivery === 'queue-if-active')
  )
  return next.length === pending.length ? pending : next
}

export function pendingQueueSendsOnTheirWay(
  pending: readonly StructuredAgentSessionPendingSend[],
  heldIds: readonly string[],
  isWorking: boolean,
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionPendingSend[] {
  if (!isWorking) {
    return []
  }
  const recorded = new Set([
    ...heldIds,
    ...handedOffQueuedMessageIds(submissions),
    ...submissions.map((submission) => submission.clientMessageId)
  ])
  return pending.filter(
    (entry) =>
      entry.phase === 'sending' &&
      entry.delivery === 'queue-if-active' &&
      !recorded.has(entry.clientMessageId)
  )
}
