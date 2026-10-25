// Host owns durable queued drafts; this pane routes card/header actions and holds only open-edit typing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { mapSettledWithConcurrency } from '../../../../shared/map-with-concurrency'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionQueuePause,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  useStructuredAgentSessionQueuedEdit,
  type QueuedEditTransport,
  type QueuedMessageInlineEditor
} from './use-structured-agent-session-queued-edit'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'
import {
  newestSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  pendingQueueSendsOnTheirWay,
  queuedMessagesQueuePause,
  sendingQueuedMessageCards,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'
import type {
  AdmitStructuredAgentSessionAction,
  CaptureStructuredAgentSessionPresentation,
  StructuredAgentSessionMutate
} from './use-structured-agent-session-mutate'

export type StructuredAgentSessionQueuedMessagesController = {
  cards: QueuedMessageCard[]
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
  /** Cmd/Ctrl+Enter: Send-now the newest card. False when there is none to steer. */
  steerNewest: () => boolean
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
  /** Host advertises `agent-session.queued-messages.v1` and the transport has a fence. */
  enabled: boolean
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  queuePause: AgentSessionQueuePause | null
  submissions: readonly AgentJournalSubmission[]
  hasPendingPrompt: boolean
  /** A turn is running, whoever started it, or the queue is about to send its next card. */
  isWorking: boolean
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

  const cards = useMemo(
    () => [
      ...projectQueuedMessageCards(queuedMessages, submissions, {
        // A command card offers no send while the agent works.
        agentWorking: isWorking,
        queuePaused: queuePause !== null
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

  const editing = useStructuredAgentSessionQueuedEdit({
    transport: args.editTransport,
    messages: queuedMessages,
    cards,
    submissions,
    composerScopeKey,
    promptOpen: hasPendingPrompt
  })

  const steerNewest = useCallback((): boolean => {
    if (!enabled) {
      return false
    }
    const newest = newestSteerableQueuedMessageCard(cardsRef.current)
    // A card already on its way leaves the chord to the composer, as with no card.
    if (!newest || inFlightRef.current.has(newest.messageId)) {
      return false
    }
    void steer(newest.messageId)
    return true
  }, [enabled, steer])

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
  const pause = useMemo(() => queuedMessagesQueuePause(cards, queuePause), [cards, queuePause])

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
    cards,
    queueCapable: enabled,
    clearCapable,
    pause,
    resume,
    clear,
    queuePending: inFlight.get(QUEUE_KEY) ?? null,
    pending: (messageId) => inFlight.get(messageId) ?? null,
    steer,
    remove,
    edit: editing.begin,
    editCapable: editing.capable,
    editor: editing.editor,
    steerNewest
  }
}
