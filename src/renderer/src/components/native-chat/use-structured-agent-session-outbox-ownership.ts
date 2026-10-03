// Who owns an outbox entry's text when it leaves this client's queue without a
// send answer. A Stop hands unsent text back to the composer — a local move; no
// text crosses a wire. A host that visibly holds the entry as a queued draft
// (same id) owns it: those entries retire with no local restore, so the same
// words can never come back twice.

import { useCallback, useEffect } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { withdrawUnsentStructuredAgentSessionOutboxEntries } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import type { useStructuredAgentSessionWithdrawnRestore } from './structured-agent-session-withdrawn-message-restore'

export function useStructuredAgentSessionOutboxOwnership(args: {
  sessionId: string
  submissions: readonly AgentJournalSubmission[]
  /** Ids of the host's published drafts; an entry with one of these ids is host-owned. */
  queuedMessageIds: readonly string[] | undefined
  /** The send in flight and its generation: a host that holds that send answered it. */
  inFlightIdRef: { current: string | null }
  dispatchGenerationRef: { current: number }
  restoreWithdrawn: ReturnType<typeof useStructuredAgentSessionWithdrawnRestore>
}): {
  /** Stop's local step, before its RPC, so the drain has nothing left to send after it. */
  withdrawUnsent: () => void
} {
  const { queuedMessageIds, restoreWithdrawn, sessionId } = args
  const { dispatchGenerationRef, inFlightIdRef, submissions } = args

  const withdrawUnsent = useCallback((): void => {
    const current = getStructuredAgentSessionOutbox(sessionId)
    const next = withdrawUnsentStructuredAgentSessionOutboxEntries(
      current,
      submissions,
      inFlightIdRef.current
    )
    if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
      return
    }
    // By id: a kept entry comes back marked, as a new object.
    const kept = new Set(next.map((entry) => entry.clientMessageId))
    restoreWithdrawn.byStop(current.filter((entry) => !kept.has(entry.clientMessageId)))
    commitStructuredAgentSessionOutbox(sessionId, next)
  }, [inFlightIdRef, restoreWithdrawn, sessionId, submissions])

  // Drop host-owned entries without a restore: the published card is the text now.
  const retire = useCallback(
    (ids: readonly string[]): void => {
      const owned = new Set(ids)
      // Like a journal row answering it: free single-flight and void the unsettled send's reply.
      if (inFlightIdRef.current !== null && owned.has(inFlightIdRef.current)) {
        dispatchGenerationRef.current += 1
        inFlightIdRef.current = null
      }
      const current = getStructuredAgentSessionOutbox(sessionId)
      const next = current.filter((entry) => !owned.has(entry.clientMessageId))
      if (next.length !== current.length) {
        commitStructuredAgentSessionOutbox(sessionId, next)
      }
    },
    [dispatchGenerationRef, inFlightIdRef, sessionId]
  )

  useEffect(() => {
    if (queuedMessageIds && queuedMessageIds.length > 0) {
      retire(queuedMessageIds)
    }
  }, [queuedMessageIds, retire])

  return { withdrawUnsent }
}
