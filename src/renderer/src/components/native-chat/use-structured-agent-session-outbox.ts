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
  reconcileStructuredAgentSessionOutbox,
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  claimOutboxDispatch,
  forgetOutboxDispatch,
  hasOutboxDispatch,
  transitionOutbox,
  transitionOutboxEntry
} from './structured-agent-session-outbox-transitions'
import { retryOutboxEntry } from './structured-agent-session-outbox-retry'
import { useStructuredAgentSessionRecovery } from './use-structured-agent-session-recovery'
import { readOutbox, subscribeOutbox } from './structured-agent-session-outbox-storage'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
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
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readOutbox(sessionId, false)
  )
  const contextRef = useRef({ sessionId, fence, targetKey })
  contextRef.current = { sessionId, fence, targetKey }
  const outboxRef = useRef(outbox)
  const claimRef = useRef<StructuredAgentSessionOutboxEntry | undefined>(undefined)
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

  useLayoutEffect(() => {
    const adopt = (entries: StructuredAgentSessionOutboxEntry[]) => {
      outboxRef.current = entries
      setOutbox(entries)
    }
    adopt(readOutbox(sessionId, false))
    return subscribeOutbox(sessionId, adopt)
  }, [sessionId])

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    blockedIdRef.current = null
    // Recover persisted dispatches after renderer restart, never another mounted owner's claim.
    transitionOutbox(sessionId, (entries) =>
      entries.map((entry) =>
        entry.state === 'dispatching' && !hasOutboxDispatch(entry)
          ? { ...entry, state: entry.recovery ? ('unconfirmed' as const) : ('queued' as const) }
          : entry
      )
    )
    return () => {
      const claim = claimRef.current
      claimRef.current = undefined
      if (claim) {
        forgetOutboxDispatch(claim)
        transitionOutboxEntry(claim, (entry) => ({
          ...entry,
          state:
            !entry.recovery &&
            contextRef.current.sessionId === sessionId &&
            (contextRef.current.fence !== fence || contextRef.current.targetKey !== targetKey)
              ? 'queued'
              : 'unconfirmed'
        }))
      }
    }
  }, [fence, sessionId, targetKey])

  useEffect(() => {
    const headId = outboxRef.current[0]?.clientMessageId
    if (
      submissions.some(
        (entry) => entry.clientMessageId === headId && entry.dispatchState === 'accepted'
      )
    ) {
      setError(null)
      blockedIdRef.current = null
    }
    const result = transitionOutbox(sessionId, (entries) =>
      reconcileStructuredAgentSessionOutbox(entries, submissions)
    )
    if (!result.ok) {
      setError('Message could not be saved to the outbox')
    }
  }, [sessionId, submissions])

  useEffect(() => {
    const next = outbox[0]
    if (
      !next ||
      next.sessionId !== sessionId ||
      next.state !== 'queued' ||
      fence === null ||
      next.dispatchBlocked ||
      blockedIdRef.current === next.clientMessageId
    ) {
      return
    }
    const dispatchGeneration = dispatchGenerationRef.current
    const reserved = claimOutboxDispatch(next)
    if (!reserved.ok) {
      blockedIdRef.current = next.clientMessageId
      setError('Message could not be saved to the outbox')
      return
    }
    if (!reserved.changed || !reserved.entry) {
      return
    }
    const claim = reserved.entry
    claimRef.current = claim
    const complete = (
      update: (
        entry: StructuredAgentSessionOutboxEntry
      ) => StructuredAgentSessionOutboxEntry | null,
      accepted = false
    ): boolean => {
      const result = transitionOutboxEntry(claim, update, accepted)
      if (!result.ok) {
        setError('Message could not be saved to the outbox')
      }
      return result.changed
    }
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
          let blockedId: string | null = null
          const changed = complete((entry) => {
            const updated = requeueStructuredAgentSessionSendRefusal(
              entry,
              result.refusal.code,
              structuredSessionOperationId
            )
            blockedId = updated.clientMessageId
            return { ...updated, dispatchBlocked: true }
          })
          if (changed) {
            setError(result.refusal.message)
            blockedIdRef.current = blockedId
          }
          return
        }
        const submission = result.value.submission
        const accepted = submission.dispatchState === 'accepted'
        const changed = complete(
          (entry) =>
            accepted
              ? null
              : {
                  ...entry,
                  dispatchBlocked: submission.dispatchState === 'rejected',
                  state:
                    submission.dispatchState === 'unknown' || submission.dispatchState === 'pending'
                      ? 'unconfirmed'
                      : 'queued'
                },
          accepted
        )
        if (changed) {
          if (submission.dispatchState === 'rejected') {
            blockedIdRef.current = next.clientMessageId
            setError(submission.reason ?? 'Message was not accepted')
          } else {
            setError(null)
          }
        }
      })
      .catch((caught) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        const failure = classifyStructuredAgentSessionSendFailure(caught, isDesktopDeliveryUnknown)
        const changed = complete((entry) => ({
          ...entry,
          dispatchBlocked: failure === 'failed',
          state: failure === 'delivery-unknown' ? 'unconfirmed' : 'queued'
        }))
        if (changed) {
          if (failure === 'failed') {
            blockedIdRef.current = next.clientMessageId
          }
          setError(
            failure === 'delivery-unknown' ? 'Message delivery is unconfirmed' : String(caught)
          )
        }
      })
      .finally(() => {
        forgetOutboxDispatch(claim)
        if (claimRef.current === claim) {
          claimRef.current = undefined
        }
      })
  }, [fence, outbox, sessionId, target])

  const head = outbox[0]
  const recovery = useStructuredAgentSessionRecovery({
    sessionId,
    fence,
    targetKey,
    head,
    hostObserved:
      !!head &&
      submissions.some((submission) => submission.clientMessageId === head.clientMessageId),
    outboxRef,
    setError
  })

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
      if (!transitionOutbox(sessionId, (entries) => [...entries, entry]).ok) {
        setError('Message could not be saved to the outbox')
        return false
      }
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
    if (!retryOutboxEntry(sessionId, clientMessageId, submission, structuredSessionOperationId)) {
      setError('Message could not be saved to the outbox')
    }
  }
  return {
    outbox,
    error,
    blockedClientMessageId: head?.dispatchBlocked ? head.clientMessageId : blockedIdRef.current,
    send,
    retry,
    ...recovery
  }
}
