import type { AgentSessionSendResult } from '../agent-session-wire'
import { agentJournalSubmissionAwaitsAgent } from '../requests/agent-session-queued-submission'
import type { AgentJournalSubmissionFields } from '../journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../requests/agent-session-queued-message-wire'
import {
  structuredAgentSubmissionIndexes,
  type StructuredAgentSubmission
} from './structured-agent-session-submissions'
import type { StructuredAgentSessionOptimisticMessage } from './structured-agent-session-message-projection'
import { handedOffQueuedMessageIds } from './structured-agent-session-draft-hand-off'
import {
  queuedMessageCardImages,
  queuedMessageCardText,
  queuedMessageSteersIn,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'

/** Cover the gap between sending a queued draft and the host publishing its card. */
export function sendingQueuedMessageCards(
  pending: readonly StructuredAgentSessionOptimisticMessage[],
  heldIds: readonly string[],
  isWorking: boolean,
  submissions: readonly AgentJournalSubmissionFields[]
): QueuedMessageCard[] {
  if (!isWorking || pending.length === 0) {
    return []
  }
  const recorded = new Set([
    ...heldIds,
    ...handedOffQueuedMessageIds(submissions),
    ...submissions.map((submission) => submission.clientMessageId)
  ])
  return pending
    .filter(
      (entry) =>
        entry.phase !== 'unconfirmed' &&
        entry.delivery === 'queue-if-active' &&
        !recorded.has(entry.clientMessageId)
    )
    .map((entry, index) => ({
      messageId: entry.clientMessageId,
      // After every card the host holds, in send order.
      position: Number.MAX_SAFE_INTEGER - pending.length + index,
      text: queuedMessageCardText(entry.body),
      ...queuedMessageCardImages(entry.body),
      state: 'waiting',
      hold: 'sending'
    }))
}

/** Steers the running turn has yet to take in read as sent messages, as when the host steers at once. */
export function steeringQueuedMessageEchoes(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly StructuredAgentSubmission[],
  pending: readonly Pick<StructuredAgentSessionOptimisticMessage, 'clientMessageId' | 'queuedAt'>[],
  session: Parameters<typeof queuedMessageSteersIn>[1]
): StructuredAgentSessionOptimisticMessage[] {
  const steering = (queuedMessages ?? []).filter((message) =>
    queuedMessageSteersIn(message, session)
  )
  if (steering.length === 0) {
    return []
  }
  const { handedOffDrafts } = structuredAgentSubmissionIndexes(submissions)
  const sentAt = new Map(pending.map((entry) => [entry.clientMessageId, entry.queuedAt]))
  return steering
    .filter((message) => !handedOffDrafts.has(message.messageId))
    .sort((left, right) => left.position - right.position)
    .map((message) => ({
      clientMessageId: message.messageId,
      body: message.body,
      queuedAt: sentAt.get(message.messageId) ?? null,
      phase: 'recorded'
    }))
}

export const EMPTY_QUEUED_STEER_INTENTS: ReadonlyMap<string, string> = new Map()

const queuedMessageIndexes = new WeakMap<
  readonly AgentSessionQueuedMessage[],
  ReadonlyMap<string, AgentSessionQueuedMessage>
>()

export function reconcileQueuedSteerIntents(
  intents: ReadonlyMap<string, string>,
  queuedMessages: readonly AgentSessionQueuedMessage[] | null,
  submissions: readonly StructuredAgentSubmission[],
  session: Parameters<typeof queuedMessageSteersIn>[1]
): ReadonlyMap<string, string> {
  if (intents.size === 0) {
    return intents
  }
  if (!session.agentWorking || session.queuePaused || !queuedMessages?.length) {
    return EMPTY_QUEUED_STEER_INTENTS
  }
  const next = new Map(intents)
  let cards = queuedMessageIndexes.get(queuedMessages)
  if (!cards) {
    cards = new Map(queuedMessages.map((card) => [card.messageId, card]))
    queuedMessageIndexes.set(queuedMessages, cards)
  }
  const { positions, handedOffDrafts } = structuredAgentSubmissionIndexes(submissions)
  const pressed = { ...session, steerIntents: intents }
  for (const [id, operation] of intents) {
    const card = cards.get(id)
    if (
      !card ||
      !queuedMessageSteersIn(card, pressed) ||
      card.steers ||
      positions.has(operation) ||
      handedOffDrafts.has(id)
    ) {
      next.delete(id)
    }
  }
  return next.size === intents.size ? intents : next
}

function queuedSteerAwaitsReceipt(result: AgentSessionSendResult | null): boolean {
  return (
    result !== null &&
    ('queued' in result
      ? result.queued.state === 'waiting'
      : agentJournalSubmissionAwaitsAgent(result.submission, result.submission.writtenAt))
  )
}

export async function settleQueuedSteerRequest(
  send: () => Promise<AgentSessionSendResult | null>,
  retire: () => void
): Promise<AgentSessionSendResult | null> {
  let result: AgentSessionSendResult | null = null
  try {
    result = await send()
    return result
  } finally {
    if (!queuedSteerAwaitsReceipt(result)) {
      retire()
    }
  }
}
