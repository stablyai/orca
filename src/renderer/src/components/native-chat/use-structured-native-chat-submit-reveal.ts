// Local actions reveal this pane at the press. Resume reveals once the host lifts the pause;
// host delivery, queued drafts and Stop never move the reader.

import { useCallback, useMemo } from 'react'
import {
  useNativeChatRevealLatest,
  type NativeChatMessageListHandle
} from './use-native-chat-reveal-latest'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

type StructuredController = ReturnType<typeof useStructuredAgentSession>

export function useStructuredNativeChatSubmitReveal(
  controller: Pick<StructuredController, 'respond' | 'queuedMessages' | 'capturePresentation'>,
  /** Relaunches a start that failed. */
  retryLaunch: () => void,
  /** The host may take no turn: no card is sent now or resumed, and no failed start retried. */
  startsHeld = false
): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  /** For the composer, which reveals as it sends. */
  revealLatest: () => void
  retryLaunch: () => void
  respond: StructuredController['respond']
  queuedMessages: StructuredAgentSessionQueuedMessagesController
} {
  const { messageListRef, revealLatest } = useNativeChatRevealLatest()
  const { respond, queuedMessages, capturePresentation } = controller
  const revealingRetryLaunch = useCallback(() => {
    if (startsHeld) {
      return
    }
    revealLatest()
    retryLaunch()
  }, [retryLaunch, revealLatest, startsHeld])
  const revealingRespond = useCallback<StructuredController['respond']>(
    (...args) => {
      revealLatest()
      return respond(...args)
    },
    [respond, revealLatest]
  )
  const revealingQueue = useMemo<StructuredAgentSessionQueuedMessagesController>(() => {
    // Resume can be refused or find nothing paused, so it reveals only once the host lifts it.
    const revealing = (lift: () => Promise<boolean>) => async (): Promise<boolean> => {
      const isCurrent = capturePresentation()
      const resumed = await lift()
      if (resumed && isCurrent()) {
        revealLatest()
      }
      return resumed
    }
    if (startsHeld) {
      return {
        ...queuedMessages,
        steer: async () => undefined,
        resume: async () => false,
        steerNewest: () => false
      }
    }
    return {
      ...queuedMessages,
      steer: (messageId) => {
        revealLatest()
        return queuedMessages.steer(messageId)
      },
      resume: revealing(queuedMessages.resume),
      steerNewest: () => {
        const steered = queuedMessages.steerNewest()
        if (steered) {
          revealLatest()
        }
        return steered
      }
    }
  }, [capturePresentation, queuedMessages, revealLatest, startsHeld])
  return {
    messageListRef,
    revealLatest,
    retryLaunch: revealingRetryLaunch,
    respond: revealingRespond,
    queuedMessages: revealingQueue
  }
}
