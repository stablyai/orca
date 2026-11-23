import {
  useStructuredAgentSessionQueuedReorder,
  type QueuedMessageReorder
} from './use-structured-agent-session-queued-reorder'
// Host owns durable queued drafts; this pane routes card/header actions and holds only open-edit typing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { mapSettledWithConcurrency } from '../../../../../shared/concurrency/map-with-concurrency'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionQueuePause
} from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionSendResult } from '../../../../../shared/agent-session/agent-session-wire'
import { useStructuredAgentSessionQueuedEdit } from './editing/use-structured-agent-session-queued-edit'
import type {
  QueuedEditTransport,
  QueuedMessageInlineEditor
} from './editing/native-chat-queued-edit-session'
import type { StructuredAgentSessionPendingSend } from '../session/structured/delivery/structured-agent-session-pending-sends'
import {
  headSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  type QueuedMessageCard
} from '../../../../../shared/agent-session/view/structured-agent-session-queued-cards'
import { useStructuredAgentSessionWaitingAgentMail } from './use-structured-agent-session-waiting-agent-mail'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  pendingQueueSendsOnTheirWay,
  sendingQueuedMessageCards
} from './structured-agent-session-sending-queued-cards'
import type {
  AdmitStructuredAgentSessionAction,
  CaptureStructuredAgentSessionPresentation,
  StructuredAgentSessionMutate
} from '../session/structured/writes/use-structured-agent-session-mutate'

export type StructuredAgentSessionQueuedMessagesController = {
  cards: QueuedMessageCard[]
  reorder?: QueuedMessageReorder
  /** Cards can show unsent messages without host queue support; queue settings/steer then have no effect. */
  queueCapable: boolean
  /** Clear all waits for sends/actions so it cannot silently clear fewer cards than shown. */
  clearCapable: boolean
  /** Host pause reason for sendable cards; accept future reason strings from newer hosts. */
  pause: { reason: string } | null
  /** Whether the host lifted the pause; a failure is a toast, and Resume is the retry. */
  resume: () => Promise<boolean>
  /** Delete every card shown; false when one could not be (already a toast). */
  clear: () => Promise<boolean>
  /** Resume or Clear all on its way: both header actions grey, and the pressed one spins. */
  queuePending: QueuedMessagesPendingAction | null
  /** Card action or enclosing Clear in flight; disable the card and spin the pressed control. */
  pending: (messageId: string) => QueuedMessagesPendingAction | null
  /** Send-now into the running turn; the transcript shows it at delivery position. */
  steer: (messageId: string) => Promise<void>
  remove: (messageId: string) => Promise<void>
  /** The host edits cards in place; without it a card offers no Edit. */
  editCapable: boolean
  editor: QueuedMessageInlineEditor | undefined
  edit: (messageId: string) => Promise<void>
  /** Cmd/Ctrl+Shift+Enter: steer the head card; absent while there is no head card to steer. */
  steerHead: (() => boolean) | undefined
  /** The agent is working, so a card's send steers into its turn. */
  isWorking: boolean
  /** The host still holds this message: a card here, or another agent's mail the transcript draws. */
  holds: (messageId: string) => boolean
  /** Other agents' waiting mail, drawn after the chat's live activity instead of as cards. */
  agentMail: readonly NativeChatMessage[]
  /** Whether a waiting agent message offers Edit, which opens it in the queue's editor. */
  agentMailEditable: (messageId: string) => boolean
  /** Waiting agent mail is first in line, so the steer shortcut sends it rather than a card. */
  mailLeads: boolean
  /** A Stop is ending the turn: nothing steers into it. */
  stopping: boolean
}

export type QueuedMessagesPendingAction = 'send' | 'delete' | 'resume' | 'clear'

const NO_SENDS: readonly StructuredAgentSessionPendingSend[] = []
const CLEAR_DELETE_CONCURRENCY = 8
/** Held by Resume and Clear all, so each refuses the other; message ids never contain NUL. */
const QUEUE_KEY = '\u0000queue'

function alreadySentNotice(): void {
  toast.error(
    translate('components.native-chat.queuedMessages.alreadySent', 'This message was already sent.')
  )
}

export function useStructuredAgentSessionQueuedMessages(args: {
  /** Host advertises `agent-session.queued-messages.v2` and the transport has a fence. */
  enabled: boolean
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  queuePause: AgentSessionQueuePause | null
  submissions: readonly AgentJournalSubmission[]
  hasPendingPrompt: boolean
  /** A turn is running, whoever started it, or the queue is about to send its next card. */
  isWorking: boolean
  stopping: boolean
  /** The pane draws a transcript, where other agents' waiting mail is drawn. */
  transcriptShown: boolean
  /** This pane's sends without a host record yet show as sending cards. */
  sending?: readonly StructuredAgentSessionPendingSend[]
  composerScopeKey: string | undefined
  mutate: StructuredAgentSessionMutate
  admit: AdmitStructuredAgentSessionAction
  capturePresentation: CaptureStructuredAgentSessionPresentation
  editTransport: QueuedEditTransport
}): StructuredAgentSessionQueuedMessagesController {
  const { composerScopeKey, enabled, hasPendingPrompt, mutate, queuedMessages, submissions } = args
  const { admit, capturePresentation, isWorking, queuePause } = args
  const sending = args.sending ?? NO_SENDS

  const allCards = useMemo(
    () => [
      ...projectQueuedMessageCards(queuedMessages, submissions, {
        // A command card offers no send while the agent works.
        agentWorking: isWorking,
        queuePaused: queuePause !== null,
        steersInTranscript: true
      }),
      ...sendingQueuedMessageCards(
        pendingQueueSendsOnTheirWay(
          sending,
          (queuedMessages ?? []).map((message) => message.messageId),
          isWorking,
          submissions
        )
      )
    ],
    [isWorking, sending, queuePause, queuedMessages, submissions]
  )
  const editing = useStructuredAgentSessionQueuedEdit({
    transport: args.editTransport,
    messages: queuedMessages,
    cards: allCards,
    submissions,
    composerScopeKey,
    promptOpen: hasPendingPrompt
  })
  const editingMessageId = editing.editor?.messageId
  const mail = useStructuredAgentSessionWaitingAgentMail({
    queuedMessages,
    submissions,
    queuePause,
    allCards,
    editingMessageId,
    editCapable: editing.capable,
    transcriptShown: args.transcriptShown
  })
  const { cards, pause } = mail
  const reordered = useStructuredAgentSessionQueuedReorder(
    cards,
    args.editTransport,
    capturePresentation
  )
  const cardsRef = useRef(cards)
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  // Refs close same-frame double-click/chord races before disabled state renders.
  const inFlightRef = useRef(new Map<string, QueuedMessagesPendingAction>())
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, QueuedMessagesPendingAction>>(
    () => new Map()
  )
  const run = useCallback(
    async <T>(
      keys: readonly string[],
      pending: QueuedMessagesPendingAction,
      action: () => Promise<T>
    ): Promise<T | false> => {
      const held = inFlightRef.current
      if (keys.some((key) => held.has(key))) {
        return false
      }
      keys.forEach((key) => held.set(key, pending))
      setInFlight(new Map(held))
      try {
        return await action()
      } finally {
        keys.forEach((key) => held.delete(key))
        setInFlight(new Map(held))
      }
    },
    []
  )

  const steer = useCallback(
    async (messageId: string): Promise<void> => {
      await run([messageId], 'send', () =>
        mutate<AgentSessionSendResult>(
          'agentSession.queuedMessageSend',
          'agentSession.queuedMessageSend',
          { messageId }
        )
      )
    },
    [mutate, run]
  )

  const remove = useCallback(
    async (messageId: string): Promise<void> => {
      const isCurrent = capturePresentation()
      await run([messageId], 'delete', async () => {
        const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
        if (isCurrent() && result && !result.deleted && result.disposition === 'dispatched') {
          alreadySentNotice()
        }
      })
    },
    [capturePresentation, mutate, run]
  )

  const steerOrder = mail.mailLeads ? allCards : reordered.cards
  const steerHead = useCallback((): boolean => {
    if (!enabled) {
      return false
    }
    const head = headSteerableQueuedMessageCard(steerOrder)
    if (!head || editingMessageId === head.messageId || inFlightRef.current.has(head.messageId)) {
      return false
    }
    void steer(head.messageId)
    return true
  }, [editingMessageId, enabled, steerOrder, steer])
  const steerableHead = enabled ? headSteerableQueuedMessageCard(steerOrder) : null
  // The same checks as the press, read from rendered state, so the composer never offers a dead steer.
  const headSteers =
    steerableHead !== null &&
    editingMessageId !== steerableHead.messageId &&
    !inFlight.has(steerableHead.messageId)

  const resume = useCallback(
    (): Promise<boolean> =>
      run([QUEUE_KEY], 'resume', async () => {
        const result = await mutate<AgentSessionQueuedMessagesResumeResult>(
          'agentSession.queuedMessagesResume',
          'agentSession.queuedMessagesResume',
          {}
        )
        return result?.resumed === true
      }),
    [mutate, run]
  )

  const pending = useCallback(
    (messageId: string): QueuedMessagesPendingAction | null => inFlight.get(messageId) ?? null,
    [inFlight]
  )

  const clearCapable = !cards.some(
    (card) => card.hold === 'sending' || inFlight.has(card.messageId)
  )
  const clear = useCallback(async (): Promise<boolean> => {
    const messageIds = cardsRef.current
      .filter((card) => card.hold !== 'sending')
      .map((card) => card.messageId)
    if (!clearCapable || messageIds.length === 0) {
      return false
    }
    const isCurrent = capturePresentation()
    // Refused while any of these cards is in flight; each shows busy until the whole Clear settles.
    return run([QUEUE_KEY, ...messageIds], 'clear', async () => {
      const action = admit()
      if (!action) {
        return false
      }
      const results = await mapSettledWithConcurrency(
        messageIds,
        CLEAR_DELETE_CONCURRENCY,
        (messageId) =>
          action.write<AgentSessionQueuedMessageDeleteResult>(
            'agentSession.queuedMessageDelete',
            'agentSession.queuedMessageDelete',
            { messageId }
          )
      )
      const dispatched = results.some(
        (result) =>
          result.status === 'fulfilled' &&
          result.value.kind === 'done' &&
          !result.value.value.deleted &&
          result.value.value.disposition === 'dispatched'
      )
      const failure = results.find(
        (result) => result.status === 'fulfilled' && result.value.kind === 'not-done'
      )
      if (isCurrent() && failure?.status === 'fulfilled' && failure.value.kind === 'not-done') {
        toast.error(failure.value.notice)
      }
      if (isCurrent() && dispatched) {
        alreadySentNotice()
      }
      return (
        !dispatched &&
        results.every((result) => result.status === 'fulfilled' && result.value.kind === 'done')
      )
    })
  }, [admit, capturePresentation, clearCapable, run])

  return {
    cards: reordered.cards,
    reorder: reordered.reorder,
    queueCapable: enabled,
    clearCapable,
    pause,
    resume,
    clear,
    queuePending: inFlight.get(QUEUE_KEY) ?? null,
    pending,
    steer,
    remove,
    edit: editing.begin,
    editCapable: editing.capable,
    editor: editing.editor,
    steerHead: headSteers ? steerHead : undefined,
    isWorking,
    holds: mail.holds,
    stopping: args.stopping,
    agentMail: mail.agentMail,
    agentMailEditable: mail.agentMailEditable,
    mailLeads: mail.mailLeads
  }
}
