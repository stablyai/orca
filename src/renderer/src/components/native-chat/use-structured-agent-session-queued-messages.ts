// Host-held drafts as this pane acts on them: the card list, Send-now (Steer),
// Delete, Edit, the Cmd/Ctrl+Enter steer chord, Resume of a held queue, and
// clearing it before a new message.
// Everything durable lives on the host, and no draft text ever travels back over
// the wire: Edit copies the text the card already shows into the composer,
// locally, before deleting the draft, so no RPC outcome can lose it.

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
import { nativeChatComposerDraftWriteSettled } from './native-chat-composer-draft-store'
import {
  newestSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  queuedMessagesQueuePause,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type { NativeChatQueueHold } from './native-chat-composer-types'

export type StructuredAgentSessionQueuedMessagesController = {
  cards: QueuedMessageCard[]
  /** The host queues sends. Without it a card can still show — a message the host kept unsent —
   *  but queueing settings and the steer chord would do nothing. */
  queueCapable: boolean
  /** Why the queue holds cards Resume would send: the header row above them. A string reason: a
   *  newer host may name one this build does not know. */
  pause: { reason: string } | null
  /** Whether the host lifted the pause; a failure is a toast, and Resume is the retry. Shared by
   *  the header row and the composer. */
  resume: () => Promise<boolean>
  /** A Resume is in flight. */
  resuming: boolean
  /** Send-now into the running turn; the transcript shows it at delivery position. */
  steer: (messageId: string) => Promise<void>
  remove: (messageId: string) => Promise<void>
  /** Copy the card's shown text into the composer, then delete the draft. */
  edit: (messageId: string) => Promise<void>
  /** Cmd/Ctrl+Enter: Send-now the newest card. False when there is none to steer. */
  steerNewest: () => boolean
  /** Present while the header row shows and the queue could send now: the composer offers
   *  Resume. A failure is a toast, and Resume stays the retry. */
  queueResume: StructuredAgentSessionQueueResume | undefined
  /** Present while `queueResume` is: a new message first asks whether to clear the cards. */
  queueHold: NativeChatQueueHold | undefined
}

export type StructuredAgentSessionQueueResume = {
  /** Whether the host lifted the pause (`resume`). */
  resume: () => Promise<boolean>
  /** A Resume is in flight. */
  resuming: boolean
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
  /** A turn is running, whoever started it, or the queue is about to send its next card. */
  isWorking: boolean
  composerScopeKey: string | undefined
  mutate: StructuredAgentSessionMutate
}): StructuredAgentSessionQueuedMessagesController {
  const { composerScopeKey, enabled, hasPendingPrompt, mutate, queuedMessages, submissions } = args
  const { queuePause } = args

  const cards = useMemo(
    () =>
      projectQueuedMessageCards(queuedMessages, submissions, {
        hasPendingPrompt,
        queuePaused: queuePause !== null
      }),
    [hasPendingPrompt, queuePause, queuedMessages, submissions]
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

  /** True once the card has left the queue, deleted or already sent; a failure is a toast. */
  const removeCard = useCallback(
    async (messageId: string): Promise<boolean> => {
      let removed = false
      await actOnce(messageId, async () => {
        const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
        if (result && !result.deleted && result.disposition === 'dispatched') {
          alreadySentNotice()
        }
        removed = result !== null
      })
      return removed
    },
    [actOnce, mutate]
  )
  const remove = useCallback(
    async (messageId: string): Promise<void> => {
      await removeCard(messageId)
    },
    [removeCard]
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
        // The card goes only once storage holds the draft; a refused save keeps it.
        if (!(await nativeChatComposerDraftWriteSettled(composerScopeKey))) {
          return
        }
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

  const resumingRef = useRef(false)
  const [resuming, setResuming] = useState(false)
  const resume = useCallback(async (): Promise<boolean> => {
    if (resumingRef.current) {
      return false
    }
    resumingRef.current = true
    setResuming(true)
    try {
      const result = await mutate<AgentSessionQueuedMessagesResumeResult>(
        'agentSession.queuedMessagesResume',
        'agentSession.queuedMessagesResume',
        {}
      )
      return result?.resumed === true
    } finally {
      resumingRef.current = false
      setResuming(false)
    }
  }, [mutate])
  const pause = useMemo(() => queuedMessagesQueuePause(cards, queuePause), [cards, queuePause])
  // Resume and the "Send message?" choice only where the queue could send now: no turn runs (the
  // queue's coming send counts, as the host names it) and no prompt waits, which holds the queue
  // too; the composer shows beside a prompt only when this build cannot answer it.
  const held = enabled && pause !== null && !args.isWorking && !hasPendingPrompt
  const queueResume = useMemo(
    () => (held ? { resume, resuming } : undefined),
    [held, resume, resuming]
  )

  // Every card shown, held or not: Clear queue empties the list the person sees. One at a time,
  // stopping at the first failure, so one failed press is one toast.
  const clear = useCallback(
    (): Promise<boolean> =>
      cardsRef.current.reduce<Promise<boolean>>(
        (previous, card) => previous.then((removed) => removed && removeCard(card.messageId)),
        Promise.resolve(true)
      ),
    [removeCard]
  )
  const count = cards.length
  const queueHold = useMemo(() => (held ? { count, clear } : undefined), [held, count, clear])

  return {
    cards,
    queueCapable: enabled,
    pause,
    resume,
    resuming,
    steer,
    remove,
    edit,
    steerNewest,
    queueResume,
    queueHold
  }
}
