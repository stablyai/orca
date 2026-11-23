// Reveal local actions at press and Resume after confirmed unpause; host delivery, queued drafts and Stop preserve reader position.

import { useCallback, useMemo } from 'react'
import {
  useNativeChatRevealLatest,
  type NativeChatMessageListHandle
} from '../../messages/actions/use-native-chat-reveal-latest'
import type { useStructuredAgentSession } from '../../session/structured/use-structured-agent-session'
import type { StructuredAgentSessionQueuedMessagesController } from '../../queue/use-structured-agent-session-queued-messages'
import type { NativeChatWaitingAgentMail } from '../../queue/NativeChatWaitingAgentMailActions'
import type { NativeChatRewindSurface } from '../../messages/actions/use-native-chat-rewind-host'

type StructuredController = ReturnType<typeof useStructuredAgentSession>
type RowRewind = { surface: NativeChatRewindSurface | undefined }

export function useStructuredNativeChatSubmitReveal(
  controller: Pick<StructuredController, 'respond' | 'queuedMessages' | 'capturePresentation'> & {
    rewind: RowRewind
  },
  retryLaunch: () => void,
  /** The host may take no turn: no card is sent now or resumed, and no failed start retried. */
  startsHeld = false,
  /** Where focus returns once a waiting agent message's own control is gone. */
  focusComposer?: () => void
): {
  messageListRef: React.RefObject<NativeChatMessageListHandle | null>
  revealLatest: () => void
  captureRevealLatest: () => () => void
  retryLaunch: () => void
  respond: StructuredController['respond']
  queuedMessages: StructuredAgentSessionQueuedMessagesController
  /** What transcript rows act through: rewind, and other agents' waiting mail with its actions. */
  rows: { rewind: RowRewind; waitingAgentMail: NativeChatWaitingAgentMail }
} {
  const { messageListRef, revealLatest, captureRevealLatest } = useNativeChatRevealLatest()
  const { respond, queuedMessages, capturePresentation, rewind } = controller
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
  const { steer, remove, pending, isWorking, stopping, agentMail, agentMailEditable, edit } =
    queuedMessages
  const steerAgentMail = useCallback(
    async (messageId: string) => {
      if (!startsHeld) {
        revealLatest()
        await steer(messageId)
      }
    },
    [revealLatest, startsHeld, steer]
  )
  // Narrow and stable, so the rows it reaches redraw only when the waiting mail or its actions change.
  const waitingAgentMail = useMemo<NativeChatWaitingAgentMail>(
    () => ({
      rows: agentMail,
      steer: steerAgentMail,
      remove,
      pending,
      isWorking,
      steerHeld: stopping || startsHeld,
      editable: agentMailEditable,
      edit,
      focusComposer
    }),
    [
      agentMail,
      steerAgentMail,
      remove,
      pending,
      isWorking,
      stopping,
      startsHeld,
      agentMailEditable,
      edit,
      focusComposer
    ]
  )
  const rows = useMemo(() => ({ rewind, waitingAgentMail }), [rewind, waitingAgentMail])
  return {
    messageListRef,
    revealLatest,
    captureRevealLatest,
    retryLaunch: revealingRetryLaunch,
    respond: revealingRespond,
    queuedMessages: revealingQueue,
    rows
  }
}
