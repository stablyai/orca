import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionSendDisposition } from '../../../../shared/structured-agent-session-send-disposition'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import {
  dispatchStructuredAgentSessionOutboxEntry,
  hasInFlightLaunchDispatch,
  readMountedStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-dispatch'
import { getStructuredAgentLaunchPromptDispatch } from '@/lib/structured-agent-session-launch-prompt'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
}

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and giving up
 *  restores the wedge this fixes. Growth caps the rate at one status query per 16s.
 *  A refusal that blocks the head still ends probing until a fence change or a manual
 *  Retry, because the entry leaves `unconfirmed` -- pre-existing, not closed here. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
}) {
  const { fence, sessionId, submissions, target } = args
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readMountedStructuredAgentSessionOutbox(sessionId, fence, readOutbox)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  const dispatchingRef = useRef(false)
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
    dispatchingRef.current = false
    blockedIdRef.current = null
    retryWithFreshClientMessageIdRef.current = null
    probeAttemptsRef.current = { id: null, attempts: 0 }
  }, [fence, sessionId, targetKey])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = sessionChanged
      ? readMountedStructuredAgentSessionOutbox(sessionId, fence, readOutbox)
      : outboxRef.current
    const next = current.map((entry) =>
      entry.state === 'dispatching' && !hasInFlightLaunchDispatch(entry, fence)
        ? { ...entry, state: 'queued' as const }
        : entry
    )
    if (
      sessionChanged ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
  }, [fence, sessionId, target])

  useEffect(() => {
    const current = outboxRef.current
    const headSubmission = submissions.find(
      (submission) => submission.clientMessageId === current[0]?.clientMessageId
    )
    const hostOwnsHead =
      headSubmission?.dispatchState === 'pending' || headSubmission?.dispatchState === 'accepted'
    const hostSettledHeadError =
      current[0]?.state === 'unconfirmed' ||
      blockedIdRef.current === headSubmission?.clientMessageId
    const next = reconcileStructuredAgentSessionOutbox(current, submissions)
    if (next.some((entry, index) => entry !== current[index]) || next.length !== current.length) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
    if (hostOwnsHead) {
      if (dispatchingRef.current) {
        dispatchGenerationRef.current += 1
        dispatchingRef.current = false
      }
      if (blockedIdRef.current === headSubmission.clientMessageId) {
        blockedIdRef.current = null
      }
      if (hostSettledHeadError) {
        setError(null)
      }
    }
  }, [sessionId, submissions])

  // The one place that owns the refs, the React state and the storage write.
  const applyDisposition = useCallback(
    (disposition: StructuredAgentSessionSendDisposition): void => {
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
    const next = outbox[0]
    if (!next || next.sessionId !== sessionId) {
      return
    }
    const launchDispatch =
      next.source === 'launch'
        ? getStructuredAgentLaunchPromptDispatch(
            next.sessionId,
            next.clientMessageId,
            fence ?? undefined
          )
        : undefined
    if (launchDispatch) {
      const persisted = readOutbox(sessionId, { recoverDispatching: false })
      const persistedHead = persisted[0]
      if (persistedHead?.state !== next.state) {
        outboxRef.current = persisted
        setOutbox(persisted)
      }
      void launchDispatch.then(() => {
        const latest = readOutbox(sessionId, { recoverDispatching: false })
        outboxRef.current = latest
        setOutbox(latest)
      })
      return
    }
    if (
      next.state !== 'queued' ||
      fence === null ||
      dispatchingRef.current ||
      blockedIdRef.current === next.clientMessageId
    ) {
      return
    }
    // A launch settlement may have already admitted this entry and cleared its in-flight marker
    // before this effect observes the queued React snapshot. Storage is the shared ownership
    // record; only dispatch when the persisted head is still queued.
    const persisted = readOutbox(sessionId, { recoverDispatching: false })
    const persistedHead = persisted[0]
    if (
      persistedHead?.clientMessageId !== next.clientMessageId ||
      persistedHead.state !== 'queued'
    ) {
      outboxRef.current = persisted
      setOutbox(persisted)
      return
    }
    const dispatchGeneration = dispatchGenerationRef.current
    const dispatch = dispatchStructuredAgentSessionOutboxEntry({
      next: persistedHead,
      persisted,
      sessionId,
      target,
      fence,
      dispatchGeneration,
      dispatchGenerationRef,
      dispatchingRef,
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
      void dispatch.promise.then(() => {
        const latest = readOutbox(sessionId, { recoverDispatching: false })
        outboxRef.current = latest
        setOutbox(latest)
      })
    }
  }, [applyDisposition, fence, outbox, sessionId, target])

  // A transport-side unknown may never have reached the host, and nothing else
  // moves it out of `unconfirmed`, so one wedges the whole FIFO queue. Re-issuing
  // the same envelope without `retryUnknown` is idempotent: the operation ledger
  // replays a recorded outcome, or the host performs a genuine first delivery.
  // A host-confirmed unknown stays parked until the user explicitly asks Retry
  // to replay the same operation.
  const head = outbox[0]
  // Depend on primitives: `submissions` is rebuilt on every streaming batch, so an
  // array-identity dep would reset the backoff forever while the agent is working.
  // A non-null `retryAfterUnknownSubmittedAt` means the user already retried, so
  // another request would repeat that explicit action. Only entries that have
  // never been retried are safe to probe automatically.
  const probeId =
    head &&
    head.sessionId === sessionId &&
    head.state === 'unconfirmed' &&
    head.retryAfterUnknownSubmittedAt === null
      ? head.clientMessageId
      : null
  const probeSettled =
    probeId !== null && submissions.some((submission) => submission.clientMessageId === probeId)
  useEffect(() => {
    if (probeId === null || probeSettled || fence === null) {
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
  }, [fence, probeId, probeSettled, sessionId, targetKey])

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
