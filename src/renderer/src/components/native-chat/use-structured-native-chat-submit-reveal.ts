// Reveal local actions at press and Resume after confirmed unpause; host delivery, queued drafts and Stop preserve reader position.

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
  retryLaunch: () => void,
  /** The host may take no turn: no card is sent now or resumed, and no failed start retried. */
  startsHeld = false
): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
  captureRevealLatest: () => () => void
  retryLaunch: () => void
  respond: StructuredController['respond']
  queuedMessages: StructuredAgentSessionQueuedMessagesController
} {
  const { messageListRef, revealLatest, captureRevealLatest } = useNativeChatRevealLatest()
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
      const reveal = captureRevealLatest()
      const resumed = await lift()
      if (resumed && isCurrent()) {
        reveal()
      }
      return resumed
    }
    if (startsHeld) {
      return {
        ...queuedMessages,
        steer: async () => undefined,
        resume: async () => false,
        steerHead: undefined
      }
    }
    const { steerHead } = queuedMessages
    return {
      ...queuedMessages,
      steer: (messageId) => {
        revealLatest()
        return queuedMessages.steer(messageId)
      },
      resume: revealing(queuedMessages.resume),
      steerHead:
        steerHead &&
        (() => {
          const steered = steerHead()
          if (steered) {
            revealLatest()
          }
          return steered
        })
    }
  }, [capturePresentation, captureRevealLatest, queuedMessages, revealLatest, startsHeld])
  return {
    messageListRef,
    revealLatest,
    captureRevealLatest,
    retryLaunch: revealingRetryLaunch,
    respond: revealingRespond,
    queuedMessages: revealingQueue
  }
}
