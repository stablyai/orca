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
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  composerQueuedCards,
  createWaitingAgentMailRows
} from '../../../../../shared/agent-session/view/structured-agent-session-waiting-agent-mail'

const NO_ROWS: readonly NativeChatMessage[] = []

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
  /** The pane draws a transcript; an empty pane keeps the mail as cards, with their controls. */
  transcriptShown: boolean
}) {
  const { queuedMessages, submissions, queuePause, allCards, editingMessageId, editCapable } = args
  const { transcriptShown } = args
  const rowsOf = useMemo(() => createWaitingAgentMailRows(), [])
  const waiting = useMemo(
    () => (transcriptShown ? rowsOf(queuedMessages, submissions) : NO_ROWS),
    [rowsOf, queuedMessages, submissions, transcriptShown]
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
  // Mail shown in the transcript; mail being edited is a card in the editor instead.
  const waitingIds = useMemo(
    () => new Set(agentMail.map((row) => row.queuedMessageId)),
    [agentMail]
  )
  return { cards, agentMail, waitingIds, pause, holds, agentMailEditable }
}
