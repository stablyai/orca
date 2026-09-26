import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  admitStructuredAgentSessionOutboxEntry,
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  journalAnswersInFlightSend,
  reconciledRejectionNotice,
  type StructuredAgentSessionSendDisposition
} from '../../../../shared/structured-agent-session-send-disposition'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import {
  dispatchStructuredAgentSessionOutboxEntry,
  readMountedStructuredAgentSessionOutbox,
  requeueInterruptedStructuredAgentSessionDispatches
} from './structured-agent-session-outbox-dispatch'
import { getStructuredAgentLaunchPromptDispatch } from '@/lib/structured-agent-session-launch-prompt'
import { useStructuredAgentSessionOutboxOwnerChange } from '@/runtime/structured-agent-session-accepted-send-capability'
import { createBrowserUuid } from '@/lib/browser-uuid'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(createBrowserUuid)
}

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and giving up
 *  restores the wedge this fixes. Growth caps the rate at one status query per 16s.
 *  A refusal that blocks the head still ends probing until a manual Retry (or, on an older
 *  host, a fence change), because the entry leaves `unconfirmed`. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
}) {
  const { fence, sessionId, submissions, target } = args
  // What resends, unblocks and drops a send in flight besides a Retry or a new send; see the hook.
  const owner = useStructuredAgentSessionOutboxOwnerChange(target, fence)
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readMountedStructuredAgentSessionOutbox(sessionId, fence, readOutbox)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  // The entry whose send is in flight, or null. One ref, because "is something in flight" and
  // "which entry" must never disagree: the journal can settle the tail while the head moves.
  const inFlightIdRef = useRef<string | null>(null)
  const dispatchGenerationRef = useRef(0)
  const blockedIdRef = useRef<string | null>(null)
  const retryWithFreshClientMessageIdRef = useRef<string | null>(null)
  const probeAttemptsRef = useRef({ id: null as string | null, attempts: 0 })
  const [error, setError] = useState<string | null>(null)
  const [errorSession, setErrorSession] = useState(sessionId)
  // Render-time reset (react.dev: adjusting state when a prop changes), so the
  // old session's banner neither flashes for a frame nor resurrects on return.
  if (errorSession !== sessionId) {
    setErrorSession(sessionId)
    setError(null)
  }

  useEffect(() => {
    outboxRef.current = outbox
  }, [outbox])

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    inFlightIdRef.current = null
    blockedIdRef.current = null
    retryWithFreshClientMessageIdRef.current = null
    probeAttemptsRef.current = { id: null, attempts: 0 }
  }, [owner.ownerChange, owner.targetKey, sessionId])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = sessionChanged
      ? readMountedStructuredAgentSessionOutbox(sessionId, owner.fenceRef.current, readOutbox)
      : outboxRef.current
    const next = requeueInterruptedStructuredAgentSessionDispatches(current, owner.fenceRef.current)
    if (
      sessionChanged ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
  }, [owner.fenceRef, owner.ownerChange, sessionId, target])

  useEffect(() => {
    const current = outboxRef.current
    const hostOwns = new Set(
      submissions
        .filter(
          (submission) =>
            submission.dispatchState === 'pending' || submission.dispatchState === 'accepted'
        )
        .map((submission) => submission.clientMessageId)
    )
    const next = reconcileStructuredAgentSessionOutbox(current, submissions)
    const admittedInFlight = journalAnswersInFlightSend(submissions, inFlightIdRef.current)
    if (
      admittedInFlight ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
    // Keyed on the entry actually in flight, which is no longer always the head: the journal
    // owning it outranks a send promise that has not settled, so release single-flight and make
    // that promise a no-op. Keying on the head would discard the tail's unsettled send instead,
    // and with it a refusal only that send can report.
    if (admittedInFlight) {
      dispatchGenerationRef.current += 1
      inFlightIdRef.current = null
    }
    const rejection = reconciledRejectionNotice(current, next, submissions)
    if (rejection) {
      setError(rejection)
    } else if (blockedIdRef.current !== null && hostOwns.has(blockedIdRef.current)) {
      blockedIdRef.current = null
      setError(null)
    } else if (
      current.some((entry) => entry.state === 'unconfirmed' && hostOwns.has(entry.clientMessageId))
    ) {
      setError(null)
    }
  }, [sessionId, submissions])

  // The one place that owns the refs, the React state and the storage write.
  const applyDisposition = useCallback(
    (disposition: StructuredAgentSessionSendDisposition): void => {
      // Released here rather than in a `.finally`: the state write below is what re-runs the
      // drain, so a later microtask would leave the queue with no trigger to move on.
      inFlightIdRef.current = null
      blockedIdRef.current = disposition.blockedClientMessageId
      retryWithFreshClientMessageIdRef.current = disposition.retryWithFreshClientMessageId
      setError(disposition.error)
      outboxRef.current = disposition.entries
      setOutbox(disposition.entries)
      writeOutbox(sessionId, disposition.entries)
    },
    [sessionId]
  )

  useEffect(() => {
    const head = outbox[0]
    if (!head || head.sessionId !== sessionId) {
      return
    }
    const mirrorPersisted = (): void => {
      const latest = readOutbox(sessionId, { recoverDispatching: false })
      outboxRef.current = latest
      setOutbox(latest)
    }
    // A launch settlement dispatches outside this hook's single-flight, so while its send is up
    // nothing else may go out beside it and race it for the host's arrival order.
    const launching = outbox.find((entry) => entry.source === 'launch')
    const launchDispatch = launching
      ? getStructuredAgentLaunchPromptDispatch(
          launching.sessionId,
          launching.clientMessageId,
          fence ?? undefined
        )
      : undefined
    if (launching && launchDispatch) {
      const persisted = readOutbox(sessionId, { recoverDispatching: false })
      const persistedLaunch = persisted.find(
        (entry) => entry.clientMessageId === launching.clientMessageId
      )
      if (persistedLaunch?.state !== launching.state) {
        outboxRef.current = persisted
        setOutbox(persisted)
      }
      void launchDispatch.then(mirrorPersisted)
      return
    }
    const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedIdRef.current)
    if (admission.state !== 'dispatch' || fence === null || inFlightIdRef.current !== null) {
      return
    }
    const next = admission.entry
    // A launch settlement may have already admitted this entry and cleared its in-flight marker
    // before this effect observes the queued React snapshot. Storage is the shared ownership
    // record; only dispatch when the persisted entry is still queued.
    const persisted = readOutbox(sessionId, { recoverDispatching: false })
    const persistedEntry = persisted.find((entry) => entry.clientMessageId === next.clientMessageId)
    if (persistedEntry?.state !== 'queued') {
      outboxRef.current = persisted
      setOutbox(persisted)
      return
    }
    const dispatchGeneration = dispatchGenerationRef.current
    const dispatch = dispatchStructuredAgentSessionOutboxEntry({
      next: persistedEntry,
      persisted,
      sessionId,
      target,
      fence,
      dispatchGeneration,
      dispatchGenerationRef,
      inFlightIdRef,
      blockedIdRef,
      outboxRef,
      setOutbox,
      setError,
      applyDisposition,
      createOperationId: structuredSessionOperationId
    })
    if (!dispatch.started) {
      // The launch settlement owns this entry. Its storage mutation does not update this hook's
      // local state, so mirror the settled state once the shared admission finishes.
      void dispatch.promise.then(mirrorPersisted)
    }
  }, [applyDisposition, fence, outbox, sessionId, target])

  // A transport-side unknown may never have reached the host, and nothing else
  // moves it out of `unconfirmed`, so one wedges the whole FIFO queue. Re-issuing
  // the same envelope without `retryUnknown` is idempotent: the operation ledger
  // replays a recorded outcome, or the host performs a genuine first delivery.
  // A host-confirmed unknown stays parked until the user explicitly asks Retry
  // to replay the same operation.
  // The first `unconfirmed` entry is the one holding the queue, at whatever index it sits: an
  // unconfirmed tail behind an admitted head would otherwise wedge until the head cleared,
  // which is the wedge this probe exists to prevent.
  const blocker = outbox.find((entry) => entry.state === 'unconfirmed')
  // Depend on primitives: `submissions` is rebuilt on every streaming batch, so an
  // array-identity dep would reset the backoff forever while the agent is working.
  // A non-null `retryAfterUnknownSubmittedAt` means the user already retried, so
  // another request would repeat that explicit action. Only entries that have
  // never been retried are safe to probe automatically.
  const probeId =
    blocker && blocker.sessionId === sessionId && blocker.retryAfterUnknownSubmittedAt === null
      ? blocker.clientMessageId
      : null
  const probeSettled =
    probeId !== null && submissions.some((submission) => submission.clientMessageId === probeId)
  useEffect(() => {
    if (probeId === null || probeSettled || !owner.attached) {
      return
    }
    const attempts = probeAttemptsRef.current.id === probeId ? probeAttemptsRef.current.attempts : 0
    const timer = setTimeout(
      () => {
        probeAttemptsRef.current = { id: probeId, attempts: attempts + 1 }
        const next = outboxRef.current.map((entry) =>
          entry.clientMessageId === probeId ? { ...entry, state: 'queued' as const } : entry
        )
        outboxRef.current = next
        setOutbox(next)
        writeOutbox(sessionId, next)
      },
      Math.min(UNCONFIRMED_PROBE_BASE_DELAY_MS * 2 ** attempts, UNCONFIRMED_PROBE_MAX_DELAY_MS)
    )
    return () => clearTimeout(timer)
  }, [owner.attached, owner.ownerChange, owner.targetKey, probeId, probeSettled, sessionId])

  const send = useCallback(
    (text: string, attachments: readonly { path: string; previewUri: string }[] = []): boolean => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const entry = createStructuredAgentSessionOutboxEntry({
        clientMessageId: structuredSessionOperationId(),
        sessionId,
        text,
        attachments,
        queuedAt: Date.now()
      })
      const next = [...outboxRef.current, entry]
      if (!writeOutbox(sessionId, next)) {
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    [sessionId]
  )

  const retry = (clientMessageId: string): void => {
    blockedIdRef.current = null
    setError(null)
    const submission = submissions.find(
      (candidate) => candidate.clientMessageId === clientMessageId
    )
    const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
    // A provider-history reconciliation can settle an earlier unknown as
    // rejected before the user presses Retry. Reusing that operation id only
    // replays the settled rejection forever, so rotate the id for a safe resend.
    if (
      current &&
      (submission?.dispatchState === 'rejected' ||
        retryWithFreshClientMessageIdRef.current === clientMessageId)
    ) {
      retryWithFreshClientMessageIdRef.current = null
      const rotated = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? {
              ...entry,
              clientMessageId: structuredSessionOperationId(),
              state: 'queued' as const,
              lastAttemptAt: null,
              retryAfterUnknownSubmittedAt: null
            }
          : entry
      )
      if (!writeOutbox(sessionId, rotated)) {
        setError('Message could not be saved to the outbox')
        return
      }
      outboxRef.current = rotated
      setOutbox(rotated)
      return
    }
    const retryAfterUnknownSubmittedAt =
      submission?.dispatchState === 'unknown'
        ? submission.submittedAt
        : current?.state === 'unconfirmed'
          ? -1
          : null
    const next = outboxRef.current.map((entry) =>
      entry.clientMessageId === clientMessageId
        ? {
            ...entry,
            state: 'queued' as const,
            retryAfterUnknownSubmittedAt
          }
        : entry
    )
    if (!writeOutbox(sessionId, next)) {
      setError('Message could not be saved to the outbox')
      return
    }
    outboxRef.current = next
    setOutbox(next)
  }
  return { outbox, error, blockedClientMessageId: blockedIdRef.current, send, retry }
}
