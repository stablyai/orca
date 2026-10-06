// Local actions reveal this pane at the press. Resume reveals once the host lifts the pause;
// host delivery, queued drafts and Stop never move the reader.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  useNativeChatRevealLatest,
  type NativeChatMessageListHandle
} from './use-native-chat-reveal-latest'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

type StructuredController = ReturnType<typeof useStructuredAgentSession>

export function useStructuredNativeChatSubmitReveal(
  controller: Pick<StructuredController, 'respond' | 'retry' | 'queuedMessages'>,
  /** Relaunches a start that failed; the messages parked behind it go out on publish. */
  retryLaunch: () => void
): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  /** For the composer, which reveals as it sends. */
  revealLatest: () => void
  retryDelivery: (clientMessageId: string) => void
  retryLaunch: () => void
  respond: StructuredController['respond']
  queuedMessages: StructuredAgentSessionQueuedMessagesController
} {
  const { messageListRef, revealLatest } = useNativeChatRevealLatest()
  const { respond, queuedMessages } = controller
  // Read at click time, so the notices stay put while the outbox's Retry is rebuilt each render.
  const retryRef = useRef(controller.retry)
  useEffect(() => {
    retryRef.current = controller.retry
  })
  const retryDelivery = useCallback(
    (clientMessageId: string) => {
      revealLatest()
      retryRef.current(clientMessageId)
    },
    [revealLatest]
  )
  const revealingRetryLaunch = useCallback(() => {
    revealLatest()
    retryLaunch()
  }, [retryLaunch, revealLatest])
  const revealingRespond = useCallback<StructuredController['respond']>(
    (...args) => {
      revealLatest()
      return respond(...args)
    },
    [respond, revealLatest]
  )
  const revealingQueue = useMemo<StructuredAgentSessionQueuedMessagesController>(
    () => ({
      ...queuedMessages,
      steer: (messageId) => {
        revealLatest()
        return queuedMessages.steer(messageId)
      },
      // Resume can be refused or find nothing paused, so it reveals only once the host lifts it.
      resume: async () => {
        const resumed = await queuedMessages.resume()
        if (resumed) {
          revealLatest()
        }
        return resumed
      },
      steerNewest: () => {
        const steered = queuedMessages.steerNewest()
        if (steered) {
          revealLatest()
        }
        return steered
      }
    }),
    [queuedMessages, revealLatest]
  )
  return {
    messageListRef,
    revealLatest,
    retryDelivery,
    retryLaunch: revealingRetryLaunch,
    respond: revealingRespond,
    queuedMessages: revealingQueue
  }
}
