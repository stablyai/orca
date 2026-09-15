import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  admitStructuredAgentSessionOutboxEntry,
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  structuredAgentSessionSendRequest,
  updateStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  disposeStructuredAgentSessionSendFailure,
  disposeStructuredAgentSessionSendResult,
  type StructuredAgentSessionSendDisposition
} from '../../../../shared/structured-agent-session-send-disposition'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
}

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and giving up
 *  restores the wedge this fixes. Growth caps the rate at one status query per 16s.
 *  A refusal that blocks the head still ends probing until a fence change or a manual
 *  Retry, because the entry leaves `unconfirmed` -- pre-existing, not closed here. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

function isDesktopDeliveryUnknown(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  return /timeout|disconnect|connection|closed|unavailable|cutover/i.test(text)
}

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
}) {
  const { fence, sessionId, submissions, target } = args
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readOutbox(sessionId)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  const dispatchingRef = useRef(false)
  const dispatchingIdRef = useRef<string | null>(null)
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
    dispatchingIdRef.current = null
    blockedIdRef.current = null
    retryWithFreshClientMessageIdRef.current = null
    probeAttemptsRef.current = { id: null, attempts: 0 }
  }, [fence, sessionId, targetKey])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = sessionChanged ? readOutbox(sessionId) : outboxRef.current
    const next = current.map((entry) =>
      entry.state === 'dispatching' ? { ...entry, state: 'queued' as const } : entry
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
    const hostOwns = new Set(
      submissions
        .filter(
          (submission) =>
            submission.dispatchState === 'pending' || submission.dispatchState === 'accepted'
        )
        .map((submission) => submission.clientMessageId)
    )
    const next = reconcileStructuredAgentSessionOutbox(current, submissions)
    if (next.some((entry, index) => entry !== current[index]) || next.length !== current.length) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
    // Keyed on the entry actually in flight, which is no longer always the head: the journal
    // owning it outranks a send promise that has not settled, so release single-flight and
    // make that promise a no-op.
    if (dispatchingIdRef.current !== null && hostOwns.has(dispatchingIdRef.current)) {
      dispatchGenerationRef.current += 1
      dispatchingRef.current = false
      dispatchingIdRef.current = null
    }
    if (blockedIdRef.current !== null && hostOwns.has(blockedIdRef.current)) {
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
      // Released here, not in a `.finally`: the state write below is what re-runs the drain,
      // and a later microtask would leave the queue with no other trigger to move on.
      dispatchingRef.current = false
      dispatchingIdRef.current = null
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
    const admission = admitStructuredAgentSessionOutboxEntry(outbox, blockedIdRef.current)
    const next = admission.state === 'dispatch' ? admission.entry : null
    if (!next || next.sessionId !== sessionId || fence === null || dispatchingRef.current) {
      return
    }
    dispatchingRef.current = true
    dispatchingIdRef.current = next.clientMessageId
    const dispatchGeneration = dispatchGenerationRef.current
    const staged = updateStructuredAgentSessionOutboxEntry(
      outbox,
      next.clientMessageId,
      (entry) => ({ ...entry, state: 'dispatching' as const, lastAttemptAt: Date.now() })
    )
    if (!writeOutbox(sessionId, staged)) {
      dispatchingRef.current = false
      dispatchingIdRef.current = null
      blockedIdRef.current = next.clientMessageId
      setError('Message could not be saved to the outbox')
      return
    }
    outboxRef.current = staged
    setOutbox(staged)
    void callStructuredAgentSession<AgentSessionMutationResult<AgentSessionSendResult>>(
      target,
      'agentSession.send',
      structuredAgentSessionSendRequest(next, fence)
    )
      .then((result) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        applyDisposition(
          disposeStructuredAgentSessionSendResult({
            entries: outboxRef.current,
            entry: next,
            blockedClientMessageId: blockedIdRef.current,
            result,
            createOperationId: structuredSessionOperationId
          })
        )
      })
      .catch((caught) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        applyDisposition(
          disposeStructuredAgentSessionSendFailure({
            entries: outboxRef.current,
            entry: next,
            blockedClientMessageId: blockedIdRef.current,
            cause: caught,
            isDeliveryUnknown: isDesktopDeliveryUnknown
          })
        )
      })
  }, [applyDisposition, fence, outbox, sessionId, target])

  // A transport-side unknown may never have reached the host, and nothing else
  // moves it out of `unconfirmed`, so one wedges the whole FIFO queue. Re-issuing
  // the same envelope without `retryUnknown` is idempotent: the operation ledger
  // replays a recorded outcome, or the host performs a genuine first delivery.
  // A host-confirmed unknown stays parked until the user explicitly asks Retry
  // to replay the same operation.
  // The first `unconfirmed` entry is the one holding the queue, at whatever index it sits.
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
