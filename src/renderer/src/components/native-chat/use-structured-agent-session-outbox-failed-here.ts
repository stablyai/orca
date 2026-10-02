import { useCallback, useState } from 'react'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

const NONE: ReadonlySet<string> = new Set()

/**
 * The messages whose send failed or was refused while this chat was open, in memory only. Only
 * they word their saved cause: one read back from storage may have outlived it (Orca was updated
 * since, say), and its Retry, refused again if the cause holds, brings the words back.
 */
export function useStructuredAgentSessionOutboxFailedHere(sessionId: string): {
  failedHere: ReadonlySet<string>
  /** Records the entries a send's answer gave a failure they did not carry before. */
  recordFailures: (
    before: readonly StructuredAgentSessionOutboxEntry[],
    after: readonly StructuredAgentSessionOutboxEntry[]
  ) => void
  forget: (clientMessageId: string) => void
} {
  const [recorded, setRecorded] = useState({ sessionId, ids: NONE })
  const recordFailures = useCallback(
    (
      before: readonly StructuredAgentSessionOutboxEntry[],
      after: readonly StructuredAgentSessionOutboxEntry[]
    ): void => {
      const previous = new Map(before.map((entry) => [entry.clientMessageId, entry.lastFailure]))
      const failed = after.filter(
        (entry) =>
          entry.lastFailure !== undefined &&
          previous.get(entry.clientMessageId) !== entry.lastFailure
      )
      if (failed.length === 0) {
        return
      }
      setRecorded((current) => ({
        sessionId,
        ids: new Set([
          ...(current.sessionId === sessionId ? current.ids : NONE),
          ...failed.map((entry) => entry.clientMessageId)
        ])
      }))
    },
    [sessionId]
  )
  const forget = useCallback(
    (clientMessageId: string): void => {
      setRecorded((current) => {
        if (current.sessionId !== sessionId || !current.ids.has(clientMessageId)) {
          return current
        }
        const ids = new Set(current.ids)
        ids.delete(clientMessageId)
        return { sessionId, ids }
      })
    },
    [sessionId]
  )
  return {
    failedHere: recorded.sessionId === sessionId ? recorded.ids : NONE,
    recordFailures,
    forget
  }
}
