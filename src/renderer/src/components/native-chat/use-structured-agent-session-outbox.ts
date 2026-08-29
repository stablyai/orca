import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  classifyStructuredAgentSessionSendFailure,
  createStructuredAgentSessionOutboxEntry,
  parseStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

const OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
}

function storageKey(sessionId: string): string {
  return `${OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`
}

function readOutbox(sessionId: string): StructuredAgentSessionOutboxEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? '[]')
    return Array.isArray(value)
      ? value
          .map((entry) => parseStructuredAgentSessionOutboxEntry(entry, sessionId))
          .filter((entry): entry is StructuredAgentSessionOutboxEntry => entry !== null)
          .map((entry) =>
            entry.state === 'dispatching' ? { ...entry, state: 'unconfirmed' as const } : entry
          )
          .sort((left, right) => left.queuedAt - right.queuedAt)
      : []
  } catch {
    return []
  }
}

function writeOutbox(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(storageKey(sessionId))
    } else {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(entries))
    }
    return true
  } catch {
    return false
  }
}

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
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readOutbox(sessionId)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  const dispatchingRef = useRef(false)
  const dispatchGenerationRef = useRef(0)
  const blockedIdRef = useRef<string | null>(null)
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
  }, [fence, sessionId, target])

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
    const next = reconcileStructuredAgentSessionOutbox(outboxRef.current, submissions)
    if (
      next.some((entry, index) => entry !== outboxRef.current[index]) ||
      next.length !== outboxRef.current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
  }, [sessionId, submissions])

  useEffect(() => {
    const next = outbox[0]
    if (
      !next ||
      next.sessionId !== sessionId ||
      next.state !== 'queued' ||
      fence === null ||
      dispatchingRef.current ||
      blockedIdRef.current === next.clientMessageId
    ) {
      return
    }
    dispatchingRef.current = true
    const dispatchGeneration = dispatchGenerationRef.current
    const staged = [
      { ...next, state: 'dispatching' as const, lastAttemptAt: Date.now() },
      ...outbox.slice(1)
    ]
    if (!writeOutbox(sessionId, staged)) {
      dispatchingRef.current = false
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
        if (!result.ok) {
          setError(result.refusal.message)
          const updated = outboxRef.current.map((entry) =>
            entry.clientMessageId === next.clientMessageId
              ? requeueStructuredAgentSessionSendRefusal(
                  entry,
                  result.refusal.code,
                  structuredSessionOperationId
                )
              : entry
          )
          blockedIdRef.current = updated[0]?.clientMessageId ?? null
          outboxRef.current = updated
          setOutbox(updated)
          writeOutbox(sessionId, updated)
          return
        }
        const submission = result.value.submission
        if (submission.dispatchState === 'rejected') {
          blockedIdRef.current = next.clientMessageId
          setError(submission.reason ?? 'Message was not accepted')
        } else {
          setError(null)
        }
        const updated =
          submission.dispatchState === 'accepted'
            ? outboxRef.current.filter((entry) => entry.clientMessageId !== next.clientMessageId)
            : outboxRef.current.map((entry) =>
                entry.clientMessageId === next.clientMessageId
                  ? {
                      ...entry,
                      state:
                        submission.dispatchState === 'unknown'
                          ? ('unconfirmed' as const)
                          : ('queued' as const)
                    }
                  : entry
              )
        outboxRef.current = updated
        setOutbox(updated)
        writeOutbox(sessionId, updated)
      })
      .catch((caught) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        const failure = classifyStructuredAgentSessionSendFailure(caught, isDesktopDeliveryUnknown)
        if (failure === 'failed') {
          blockedIdRef.current = next.clientMessageId
        }
        const updated = outboxRef.current.map((entry) =>
          entry.clientMessageId === next.clientMessageId
            ? {
                ...entry,
                state:
                  failure === 'delivery-unknown' ? ('unconfirmed' as const) : ('queued' as const)
              }
            : entry
        )
        setError(
          failure === 'delivery-unknown' ? 'Message delivery is unconfirmed' : String(caught)
        )
        outboxRef.current = updated
        setOutbox(updated)
        writeOutbox(sessionId, updated)
      })
      .finally(() => {
        if (dispatchGenerationRef.current === dispatchGeneration) {
          dispatchingRef.current = false
        }
      })
  }, [fence, outbox, sessionId, target])

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
    if (current && submission?.dispatchState === 'rejected') {
      const rotated = outboxRef.current.map((entry) =>
        entry.clientMessageId === clientMessageId
          ? {
              ...entry,
              clientMessageId: structuredSessionOperationId(),
              state: 'queued' as const,
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
