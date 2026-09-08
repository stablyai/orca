import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  advanceStructuredAgentSessionRecovery,
  resumeStructuredAgentSessionRecovery
} from '../../../../shared/structured-agent-session-recovery'
import { transitionOutboxEntry } from './structured-agent-session-outbox-transitions'

export function useStructuredAgentSessionRecovery(args: {
  sessionId: string
  fence: number | null
  targetKey: string
  head: StructuredAgentSessionOutboxEntry | undefined
  hostObserved: boolean
  outboxRef: MutableRefObject<StructuredAgentSessionOutboxEntry[]>
  setError: (error: string | null) => void
}) {
  const { sessionId, fence, targetKey, head, hostObserved, outboxRef, setError } = args
  const [storageBlockedId, setStorageBlockedId] = useState<string | null>(null)
  const commit = useCallback(
    (
      expected: StructuredAgentSessionOutboxEntry,
      entry: StructuredAgentSessionOutboxEntry
    ): boolean => {
      const result = transitionOutboxEntry(expected, () => entry)
      if (!result.ok) {
        setStorageBlockedId(entry.clientMessageId)
        setError('Message could not be saved to the outbox')
        return false
      }
      return true
    },
    [setError]
  )

  useEffect(() => {
    if (
      !head ||
      head.sessionId !== sessionId ||
      hostObserved ||
      fence === null ||
      head.clientMessageId === storageBlockedId
    ) {
      return
    }
    const next = advanceStructuredAgentSessionRecovery(head, Date.now())
    // Reserve the budget and deadline durably before any timer can dispatch it.
    if (next !== head && !commit(head, next)) {
      return
    }
    if (
      next.state !== 'unconfirmed' ||
      next.retryAfterUnknownSubmittedAt !== null ||
      next.recovery?.nextProbeAt == null ||
      next.recovery.parkedReason
    ) {
      return
    }
    const timer = setTimeout(
      () => {
        if (
          outboxRef.current[0]?.clientMessageId !== next.clientMessageId ||
          outboxRef.current[0]?.recovery?.nextProbeAt !== next.recovery?.nextProbeAt
        ) {
          return
        }
        commit(
          outboxRef.current[0],
          advanceStructuredAgentSessionRecovery(outboxRef.current[0], Date.now())
        )
      },
      Math.max(0, next.recovery.nextProbeAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [commit, fence, head, hostObserved, outboxRef, sessionId, storageBlockedId, targetKey])

  const resumeChecking = (clientMessageId: string): void => {
    const current = outboxRef.current[0]
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.clientMessageId !== clientMessageId ||
      hostObserved ||
      (current.recovery?.parkedReason !== 'budget-exhausted' &&
        storageBlockedId !== clientMessageId)
    ) {
      return
    }
    const next = resumeStructuredAgentSessionRecovery(current)
    if (next !== current && commit(current, next)) {
      setStorageBlockedId(null)
      setError(null)
    }
  }
  const recoveryPaused =
    head?.state === 'unconfirmed' &&
    head.retryAfterUnknownSubmittedAt === null &&
    !hostObserved &&
    (head.recovery?.parkedReason === 'budget-exhausted' ||
      storageBlockedId === head.clientMessageId)
  return { resumeChecking, recoveryPaused }
}
