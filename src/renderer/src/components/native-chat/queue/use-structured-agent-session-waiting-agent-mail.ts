import { useCallback, useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import {
  queuedMessagesQueuePause,
  type QueuedMessageCard
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import {
  composerQueuedCards,
  createWaitingAgentMailRows
} from '../../../../../shared/agent-session/view/structured-agent-session-waiting-agent-mail'

/** Splits the host's queue: other agents' waiting mail is drawn in the transcript, the rest stays
 *  the composer's cards; a paused queue holding only that mail still offers Resume. */
export function useStructuredAgentSessionWaitingAgentMail(args: {
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  submissions: readonly AgentJournalSubmission[]
  queuePause: AgentSessionQueuePause | null
  /** Every card the host holds, agent mail included. */
  allCards: QueuedMessageCard[]
  editingMessageId: string | undefined
  editCapable: boolean
}) {
  const { queuedMessages, submissions, queuePause, allCards, editingMessageId, editCapable } = args
  const rowsOf = useMemo(() => createWaitingAgentMailRows(), [])
  const waiting = useMemo(
    () => rowsOf(queuedMessages, submissions),
    [rowsOf, queuedMessages, submissions]
  )
  // Agent mail waits in the transcript; only one being edited joins the queue, in its editor.
  const { cards, agentMail } = useMemo(
    () => composerQueuedCards(allCards, waiting, editingMessageId),
    [allCards, waiting, editingMessageId]
  )
  const pause = useMemo(
    () => queuedMessagesQueuePause(cards, queuePause, waiting.length > 0),
    [cards, queuePause, waiting]
  )
  const holds = useCallback(
    (messageId: string): boolean => allCards.some((card) => card.messageId === messageId),
    [allCards]
  )
  // One pass per queue change, so each row's check is a lookup rather than a scan of the queue.
  const editableIds = useMemo(
    () =>
      editCapable && editingMessageId === undefined
        ? new Set(allCards.filter((card) => !card.notEditable).map((card) => card.messageId))
        : new Set<string>(),
    [allCards, editCapable, editingMessageId]
  )
  const agentMailEditable = useCallback(
    (messageId: string): boolean => editableIds.has(messageId),
    [editableIds]
  )
  return { cards, agentMail, pause, holds, agentMailEditable }
}
