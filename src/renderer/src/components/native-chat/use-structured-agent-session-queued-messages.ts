// Host-held drafts as this pane acts on them: the card list, Send-now (Steer),
// Delete, Edit, and the Cmd/Ctrl+Enter steer chord. Everything durable lives on
// the host, and no draft text ever travels back over the wire: Edit copies the
// text the card already shows into the composer, locally, before deleting the
// draft, so no RPC outcome can lose it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionQueuePause,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import {
  newestSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

export type StructuredAgentSessionQueuedMessagesController = {
  cards: QueuedMessageCard[]
  /** Why the whole queue sends nothing on its own; null when it drains. Shown only with cards.
   *  A string reason: a newer host may name one this build does not know. */
  pause: { reason: string } | null
  /** Lift the queue's pause; a failure is a toast, and the Resume button is the retry. */
  resume: () => Promise<void>
  /** A Resume is in flight. */
  resuming: boolean
  /** Send-now into the running turn; the transcript shows it at delivery position. */
  steer: (messageId: string) => Promise<void>
  remove: (messageId: string) => Promise<void>
  /** Copy the card's shown text into the composer, then delete the draft. */
  edit: (messageId: string) => Promise<void>
  /** Cmd/Ctrl+Enter: Send-now the newest card. False when there is none to steer. */
  steerNewest: () => boolean
}

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
  composerScopeKey: string | undefined
  mutate: StructuredAgentSessionMutate
}): StructuredAgentSessionQueuedMessagesController {
  const { composerScopeKey, enabled, hasPendingPrompt, mutate, queuedMessages, submissions } = args
  const pause = args.queuePause

  const cards = useMemo(
    () =>
      projectQueuedMessageCards(queuedMessages, submissions, {
        hasPendingPrompt,
        queuePaused: pause !== null
      }),
    [hasPendingPrompt, pause, queuedMessages, submissions]
  )
  const cardsRef = useRef(cards)
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  // One action per card at a time: a double-click or a chord repeat is not a second request.
  const actingOnRef = useRef(new Set<string>())
  const actOnce = useCallback(
    async (messageId: string, action: () => Promise<void>): Promise<void> => {
      if (actingOnRef.current.has(messageId)) {
        return
      }
      actingOnRef.current.add(messageId)
      try {
        await action()
      } finally {
        actingOnRef.current.delete(messageId)
      }
    },
    []
  )

  const steer = useCallback(
    (messageId: string): Promise<void> =>
      actOnce(messageId, async () => {
        await mutate<AgentSessionSendResult>(
          'agentSession.queuedMessageSend',
          'agentSession.queuedMessageSend',
          { messageId }
        )
      }),
    [actOnce, mutate]
  )

  const remove = useCallback(
    (messageId: string): Promise<void> =>
      actOnce(messageId, async () => {
        const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
        if (result && !result.deleted && result.disposition === 'dispatched') {
          alreadySentNotice()
        }
      }),
    [actOnce, mutate]
  )

  const edit = useCallback(
    (messageId: string): Promise<void> =>
      actOnce(messageId, async () => {
        // The text is copied FIRST, from the card this pane already shows — a local move,
        // never a wire payload. Without a composer to hold it, deleting would destroy it,
        // so the draft then stays a card.
        const card = cardsRef.current.find((entry) => entry.messageId === messageId)
        if (!card || !composerScopeKey) {
          return
        }
        appendNativeChatDraftCache(composerScopeKey, card.text)
        const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
        if (result && !result.deleted && result.disposition === 'dispatched') {
          toast.error(
            translate(
              'components.native-chat.queuedMessages.editAlreadySent',
              'Already sent — your text is still in the composer.'
            )
          )
        }
        // A failed Delete leaves the card: the text shows in both places, visibly, never lost.
      }),
    [actOnce, composerScopeKey, mutate]
  )

  const resumingRef = useRef(false)
  const [resuming, setResuming] = useState(false)
  const resume = useCallback(async (): Promise<void> => {
    if (resumingRef.current) {
      return
    }
    resumingRef.current = true
    setResuming(true)
    try {
      await mutate<AgentSessionQueuedMessagesResumeResult>(
        'agentSession.queuedMessagesResume',
        'agentSession.queuedMessagesResume',
        {}
      )
    } finally {
      resumingRef.current = false
      setResuming(false)
    }
  }, [mutate])

  const steerNewest = useCallback((): boolean => {
    if (!enabled) {
      return false
    }
    const newest = newestSteerableQueuedMessageCard(cardsRef.current)
    if (!newest) {
      return false
    }
    void steer(newest.messageId)
    return true
  }, [enabled, steer])

  return { cards, pause, resume, resuming, steer, remove, edit, steerNewest }
}
