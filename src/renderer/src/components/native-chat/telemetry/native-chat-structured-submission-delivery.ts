import type { StructuredAgentSessionReadOwner } from '../session/structured/read/structured-agent-session-read-owner-contract'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionSendRequest } from '../session/structured/delivery/structured-agent-session-send-slot'
import type { NativeChatFollowUpTelemetry } from './native-chat-telemetry'

export function createNativeChatStructuredSubmissionTelemetry(
  prior: Omit<NativeChatFollowUpTelemetry, 'submission' | 'messageId'> | undefined,
  readDelivery: (clientMessageId: string, signal: AbortSignal) => Promise<boolean>,
  onSettled?: () => void
): {
  intent: Pick<StructuredAgentSessionSendRequest, 'onCreated' | 'onSettled'>
  followUp: NativeChatFollowUpTelemetry | undefined
  cancel: () => void
} {
  const delivery = Promise.withResolvers<boolean>()
  const controller = new AbortController()
  const followUp: NativeChatFollowUpTelemetry | undefined = prior
    ? { ...prior, submission: delivery.promise }
    : undefined
  const cancel = () => {
    controller.abort()
    delivery.resolve(false)
  }
  return {
    followUp,
    cancel,
    intent: {
      ...(followUp
        ? {
            onCreated: (id: string) => {
              followUp.messageId = agentJournalSubmissionKey(id)
              void readDelivery(id, controller.signal).then(delivery.resolve)
            }
          }
        : {}),
      ...(followUp || onSettled
        ? {
            onSettled: (outcome) => {
              onSettled?.()
              if (outcome === 'returned' || outcome === 'dropped') {
                cancel()
              }
            }
          }
        : {})
    }
  }
}

/** Host custody and provider handover can both precede rejection; only acceptance proves delivery. */
export function readNativeChatStructuredSubmissionDelivery(
  owner: Pick<StructuredAgentSessionReadOwner, 'getSnapshot' | 'subscribe'>,
  clientMessageId: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const epoch = owner.getSnapshot().state.epoch
    let queued = false
    const finish = (delivered: boolean) => {
      unsubscribe()
      signal.removeEventListener('abort', abort)
      resolve(delivered)
    }
    const abort = () => finish(false)
    const observe = () => {
      const { state } = owner.getSnapshot()
      if (signal.aborted || (epoch !== null && state.epoch !== epoch)) {
        finish(false)
        return
      }
      const submissions = state.submissions.filter(
        (submission) =>
          submission.clientMessageId === clientMessageId ||
          submission.queuedMessageId === clientMessageId
      )
      if (submissions.some((submission) => submission.dispatchState === 'accepted')) {
        finish(true)
        return
      }
      const card = state.queuedMessages?.some((message) => message.messageId === clientMessageId)
      if (
        submissions.some((submission) => submission.dispatchState === 'rejected') ||
        (queued && !card && submissions.length === 0)
      ) {
        finish(false)
        return
      }
      queued ||= card === true
    }
    const unsubscribe = owner.subscribe(observe)
    signal.addEventListener('abort', abort, { once: true })
    observe()
  })
}
