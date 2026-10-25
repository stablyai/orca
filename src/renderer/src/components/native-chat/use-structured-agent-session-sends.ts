import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import type { StructuredAgentSessionSendRequest } from './structured-agent-session-send-slot'
import { useCallback, useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAttachment } from '../../../../shared/structured-agent-session-send-mutation'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  structuredAgentSessionQueueRequest,
  type StructuredAgentSessionQueueDelivery
} from './structured-agent-session-queue-request'
import {
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal,
  stopStructuredAgentSessionSends
} from './structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice,
  structuredAgentSessionSendsHeld,
  subscribeToStructuredAgentSessionPendingSends
} from './structured-agent-session-pending-sends'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'
import { recoverLegacyStructuredAgentSessionOutbox } from './structured-agent-session-legacy-outbox'
import { pendingSendsOutsideQueuedCards } from './structured-agent-session-queued-cards'

/** The open chat's view of its sends: they live in the sender, which works without this view. */
export function useStructuredAgentSessionSends(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  cursor?: AgentJournalCursor | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[]
  queue: StructuredAgentSessionQueueDelivery
  /** The chat's history has loaded, so its rows and cards can answer for a legacy copy. */
  historyLoaded: boolean
  /** Whether a new send that asks to be queued waits as a card. */
  isWorking?: boolean
  /** The chat reads Stopping: a send made now is drawn after the turn being stopped. */
  stopping?: boolean
  /** The composer's model and effort each send carries; undefined to a host that takes none. */
  sendOptions?: () => Readonly<Record<string, string>> | undefined
}) {
  const {
    cursor,
    fence,
    historyLoaded,
    isWorking = false,
    queue,
    queuedMessageIds,
    sendOptions,
    sessionId,
    stopping,
    submissions,
    target
  } = args
  // An older host refuses a send body carrying `skills`; there the `$name` text stands alone.
  const takesSkills =
    useStructuredAgentSessionHostCapabilityState(
      target,
      AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY
    ) === 'supported'
  const subscribe = useCallback(
    (listener: () => void) => subscribeToStructuredAgentSessionPendingSends(sessionId, listener),
    [sessionId]
  )
  const pending = useSyncExternalStore(subscribe, () =>
    getStructuredAgentSessionPendingSends(sessionId)
  )
  const notice = useSyncExternalStore(subscribe, () =>
    getStructuredAgentSessionSendNotice(sessionId)
  )
  const held = useSyncExternalStore(subscribe, () => structuredAgentSessionSendsHeld(sessionId))

  useEffect(() => {
    noteStructuredAgentSessionFence(sessionId, fence)
  }, [fence, sessionId])

  useEffect(() => {
    settleStructuredAgentSessionSendsFromJournal(sessionId, submissions, queuedMessageIds, cursor)
  }, [cursor, pending, queuedMessageIds, sessionId, submissions])

  const recoverLegacy = historyLoaded && fence !== null
  // Why an event: once per open, from the first loaded history; later batches add nothing it needs.
  const recoverLegacyOutbox = useEffectEvent(() => {
    void recoverLegacyStructuredAgentSessionOutbox({
      sessionId,
      target,
      submissions,
      queuedMessageIds
    })
  })
  useEffect(() => {
    if (recoverLegacy) {
      recoverLegacyOutbox()
    }
  }, [recoverLegacy, sessionId, target])

  /** Whether the message was taken; 'queued' when it waits as a queued card, not a bubble. */
  const send = useCallback(
    (
      text: string,
      attachments: readonly StructuredAgentSessionAttachment[] = [],
      request?: StructuredAgentSessionSendRequest
    ): boolean | 'queued' => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const delivery = structuredAgentSessionQueueRequest(queue)
      const options = sendOptions?.()
      const sent = sendStructuredAgentSessionMessage({
        sessionId,
        target,
        text,
        attachments,
        ...(request?.callerKeepsText ? { callerKeepsText: request.callerKeepsText } : {}),
        ...(request?.usageLimitContinuationOfTurnItemId
          ? { usageLimitContinuationOfTurnItemId: request.usageLimitContinuationOfTurnItemId }
          : {}),
        ...(delivery ? { delivery } : {}),
        ...(options ? { options } : {}),
        ...(takesSkills && request?.skills?.length ? { skills: request.skills } : {}),
        ...(stopping ? { sentWhileStopping: true as const } : {})
      })
      // Refused while the chat's send is out: the text stays in the box.
      if (!sent) {
        return false
      }
      if (request?.onSettled) {
        void sent.outcome.then(request.onSettled)
      }
      // The same projection that draws the transcript decides it.
      const admitted = getStructuredAgentSessionPendingSends(sessionId).filter(
        (entry) => entry.clientMessageId === sent.clientMessageId
      )
      return admitted.length > 0 &&
        pendingSendsOutsideQueuedCards(admitted, queuedMessageIds, isWorking).length === 0
        ? 'queued'
        : true
    },
    [isWorking, queue, queuedMessageIds, sendOptions, sessionId, stopping, takesSkills, target]
  )

  return {
    pending,
    /** A write such as a /clear keeps every send out meanwhile. */
    held,
    /** Why the last message came back to the composer, until the next send. */
    error: notice,
    send,
    stopSends: () => stopStructuredAgentSessionSends(sessionId)
  }
}
