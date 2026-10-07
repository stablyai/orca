import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  admitStructuredAgentSessionOutboxEntry,
  structuredAgentSessionEntryHeldForRetry
} from '../../../../shared/structured-agent-session-outbox-admission'
import {
  journalAnswersInFlightSend,
  STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED,
  type StructuredAgentSessionSendDisposition
} from '../../../../shared/structured-agent-session-send-disposition'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  appendStructuredAgentSessionOutboxMessage,
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  loadStructuredAgentSessionOutbox,
  readOutbox,
  subscribeToStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  dispatchStructuredAgentSessionOutboxEntry,
  readMountedStructuredAgentSessionOutbox,
  requeueInterruptedStructuredAgentSessionDispatches
} from './structured-agent-session-outbox-dispatch'
import { getStructuredAgentLaunchPromptDispatch } from '@/lib/structured-agent-session-launch-prompt'
import { useStructuredAgentSessionOutboxOwnerChange } from '@/runtime/structured-agent-session-accepted-send-capability'
import { useStructuredAgentSessionOutboxUnconfirmedProbe } from './use-structured-agent-session-outbox-unconfirmed-probe'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useStructuredAgentSessionWithdrawnRestore } from './structured-agent-session-withdrawn-message-restore'
import { useStructuredAgentSessionOutboxOwnership } from './use-structured-agent-session-outbox-ownership'
import {
  handedOffQueuedMessageIds,
  reconcileStructuredAgentSessionOutboxWithQueue
} from '../../../../shared/structured-agent-session-draft-hand-off'
import {
  structuredAgentSessionEntryAttempt,
  type StructuredAgentSessionQueueDelivery
} from '../../../../shared/structured-agent-session-outbox-delivery'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'
import { useStructuredAgentSessionOutboxFailedHere } from './use-structured-agent-session-outbox-failed-here'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { outboxOutsideQueuedCards } from './structured-agent-session-queued-cards'

const NO_QUEUE_DELIVERY: StructuredAgentSessionQueueDelivery = {
  capability: 'unsupported',
  enabled: false
}

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  /** The loaded journal rows: a rejected message stays here until the row that draws it loads. */
  journalItems: readonly AgentJournalRenderItem[]
  /** The composer that gets back, when empty, what a Stop took from this client's outbox. */
  composerScopeKey?: string
  /** The host's queued-messages capability and the user's setting; a send stamped
   *  `delivery: 'queue-if-active'` is held as a draft only while the agent is working. */
  queueDelivery?: StructuredAgentSessionQueueDelivery
  /** Ids of the host's published drafts. A queued send whose acknowledgement was lost keeps
   *  its entry here under the draft's own id; once the host visibly holds the draft, the
   *  entry retires so the same text can never come back twice. */
  queuedMessageIds?: readonly string[]
  /** With the queue delivery, whether a new send waits as a queued card. */
  isWorking?: boolean
  /** The chat reads Stopping: a send made now is marked as made while stopping. */
  stopping?: boolean
}) {
  const {
    composerScopeKey,
    fence,
    isWorking = false,
    journalItems,
    queueDelivery = NO_QUEUE_DELIVERY,
    queuedMessageIds,
    sessionId,
    stopping: sentWhileStopping = false,
    submissions,
    target
  } = args
  const { capability: queueCapability, enabled: queueEnabled } = queueDelivery
  // What resends and drops a send in flight besides a Retry or a new send; see the hook.
  const owner = useStructuredAgentSessionOutboxOwnerChange(target, fence)
  const restoreWithdrawn = useStructuredAgentSessionWithdrawnRestore(composerScopeKey)
  // The outbox lives in the session's store, shared with every other writer; this view holds it
  // open and drains it. Loading maps what a previous owner left mid-send.
  const load = useCallback(
    () => readMountedStructuredAgentSessionOutbox(sessionId, fence, readOutbox),
    // Why: only the load at open reads the fence; later fences must not re-create the hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId]
  )
  const subscribe = useCallback(
    (listener: () => void) => subscribeToStructuredAgentSessionOutbox(sessionId, load, listener),
    [load, sessionId]
  )
  const outbox = useSyncExternalStore(subscribe, () =>
    loadStructuredAgentSessionOutbox(sessionId, load)
  )
  const outboxSessionRef = useRef(sessionId)
  // The entry whose send is in flight, or null. One ref, because "is something in flight" and
  // "which entry" must never disagree: the journal can settle the tail while the head moves.
  const inFlightIdRef = useRef<string | null>(null)
  const dispatchGenerationRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const { failedHere, recordFailures, forget } =
    useStructuredAgentSessionOutboxFailedHere(sessionId)
  const [errorSession, setErrorSession] = useState(sessionId)
  // Render-time reset (react.dev: adjusting state when a prop changes), so the
  // old session's banner neither flashes for a frame nor resurrects on return.
  if (errorSession !== sessionId) {
    setErrorSession(sessionId)
    setError(null)
  }

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    inFlightIdRef.current = null
  }, [owner.ownerChange, owner.targetKey, sessionId])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = getStructuredAgentSessionOutbox(sessionId)
    const next = requeueInterruptedStructuredAgentSessionDispatches(current, owner.fenceRef.current)
    if (
      sessionChanged ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      commitStructuredAgentSessionOutbox(sessionId, next)
    }
  }, [owner.fenceRef, owner.ownerChange, sessionId, target])

  useEffect(() => {
    const current = getStructuredAgentSessionOutbox(sessionId)
    const hostOwns = new Set([
      ...submissions
        .filter(
          (submission) =>
            submission.dispatchState === 'pending' || submission.dispatchState === 'accepted'
        )
        .map((submission) => submission.clientMessageId),
      ...handedOffQueuedMessageIds(submissions)
    ])
    const next = reconcileStructuredAgentSessionOutboxWithQueue(current, submissions, journalItems)
    const admittedInFlight = journalAnswersInFlightSend(submissions, inFlightIdRef.current)
    // The reconcile returns `current` itself when no entry changed, so a batch that changes
    // nothing writes nothing.
    if (admittedInFlight || next !== current) {
      commitStructuredAgentSessionOutbox(sessionId, [...next])
    }
    // Keyed on the entry actually in flight, which is no longer always the head: the journal
    // owning it outranks a send promise that has not settled, so release single-flight and make
    // that promise a no-op. Keying on the head would discard the tail's unsettled send instead,
    // and with it a refusal only that send can report.
    if (admittedInFlight) {
      dispatchGenerationRef.current += 1
      inFlightIdRef.current = null
    }
    if (
      current.some(
        (entry) =>
          (entry.state === 'unconfirmed' || structuredAgentSessionEntryHeldForRetry(entry)) &&
          hostOwns.has(entry.clientMessageId)
      )
    ) {
      setError(null)
    }
  }, [journalItems, sessionId, submissions])

  // The one place that owns the refs, the React state and the storage write.
  const applyDisposition = useCallback(
    (outcome: StructuredAgentSessionSendDisposition): void => {
      const disposition = restoreWithdrawn.byRefusal(outcome)
      // Released here rather than in a `.finally`: the state write below is what re-runs the
      // drain, so a later microtask would leave the queue with no trigger to move on.
      inFlightIdRef.current = null
      setError(disposition.error ? agentSessionWriteNoticeText(disposition.error) : null)
      recordFailures(getStructuredAgentSessionOutbox(sessionId), disposition.entries)
      commitStructuredAgentSessionOutbox(sessionId, disposition.entries)
    },
    [recordFailures, restoreWithdrawn, sessionId]
  )

  const [drains, setDrains] = useState(0)
  const drainAgain = useCallback(() => setDrains((count) => count + 1), [])

  useEffect(() => {
    // The shared outbox, not this render's copy: an effect earlier in this commit (an owner
    // change's requeue, a reconcile) or a launch settlement may have written a newer one.
    const current = getStructuredAgentSessionOutbox(sessionId)
    const head = current[0]
    if (!head || head.sessionId !== sessionId) {
      return
    }
    // A launch settlement dispatches outside this hook's single-flight, so while its send is up
    // nothing else may go out beside it and race it for the host's arrival order. Its writes land
    // in the shared outbox, but it releases its marker after the last one, so drain again then.
    const launching = current.find((entry) => entry.source === 'launch')
    const launchDispatch = launching
      ? getStructuredAgentLaunchPromptDispatch(
          launching.sessionId,
          launching.clientMessageId,
          fence ?? undefined
        )
      : undefined
    if (launchDispatch) {
      void launchDispatch.then(drainAgain, drainAgain)
      return
    }
    const admission = admitStructuredAgentSessionOutboxEntry(current)
    if (admission.state !== 'dispatch' || fence === null || inFlightIdRef.current !== null) {
      return
    }
    const next = admission.entry
    // The request reads the capability; the entry keeps only what its first attempt sent.
    const attempt = structuredAgentSessionEntryAttempt(next, {
      capability: queueCapability,
      enabled: queueEnabled
    })
    const dispatch = dispatchStructuredAgentSessionOutboxEntry({
      next: attempt.wire,
      entries: current.map((entry) => (entry === next ? attempt.stored : entry)),
      sessionId,
      target,
      fence,
      dispatchGeneration: dispatchGenerationRef.current,
      dispatchGenerationRef,
      inFlightIdRef,
      setError,
      applyDisposition,
      createOperationId: structuredSessionOperationId
    })
    if (!dispatch.started) {
      // A launch settlement already owns this entry's send.
      void dispatch.promise.then(drainAgain, drainAgain)
    }
  }, [
    applyDisposition,
    drainAgain,
    drains,
    fence,
    outbox,
    queueCapability,
    queueEnabled,
    sessionId,
    target
  ])

  useStructuredAgentSessionOutboxUnconfirmedProbe({
    sessionId,
    outbox,
    submissions,
    owner
  })

  /** Whether the message was admitted; 'queued' when it waits as a queued card, not a bubble. */
  const send = useCallback(
    (
      text: string,
      attachments: readonly { path: string; previewUri: string }[] = []
    ): boolean | 'queued' => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      // Whether it asks to be queued is decided when it first goes out.
      if (
        !appendStructuredAgentSessionOutboxMessage(
          sessionId,
          text,
          attachments,
          undefined,
          sentWhileStopping
        )
      ) {
        setError(agentSessionWriteNoticeText(STRUCTURED_AGENT_SESSION_OUTBOX_NOT_SAVED))
        return false
      }
      setError(null)
      // The same projection that draws the transcript decides it.
      const current = getStructuredAgentSessionOutbox(sessionId)
      const admitted = current.at(-1)
      const shown = outboxOutsideQueuedCards(
        current,
        queuedMessageIds ?? [],
        isWorking,
        queueDelivery
      )
      return admitted && !shown.includes(admitted) ? 'queued' : true
    },
    [isWorking, queueDelivery, queuedMessageIds, sentWhileStopping, sessionId]
  )

  const { withdrawUnsent } = useStructuredAgentSessionOutboxOwnership({
    sessionId,
    submissions,
    queuedMessageIds,
    inFlightIdRef,
    dispatchGenerationRef,
    restoreWithdrawn
  })

  const retry = (clientMessageId: string): void => {
    setError(null)
    forget(clientMessageId)
    retryStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId,
      submissions,
      setError,
      createOperationId: structuredSessionOperationId
    })
  }
  return {
    outbox,
    error,
    failedHere,
    send,
    retry,
    withdrawUnsent
  }
}
