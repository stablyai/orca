import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryResendsUnconfirmed } from '../../../../shared/structured-agent-session-outbox-unconfirmed-resend'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and giving up
 *  restores the wedge this fixes. Growth caps the rate at one status query per 16s.
 *  A refusal still ends probing until a manual Retry, because the entry leaves `unconfirmed`. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

/** Re-queues the entry holding the outbox in `unconfirmed`, with backoff, until the journal answers it. */
export function useStructuredAgentSessionOutboxUnconfirmedProbe(args: {
  sessionId: string
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  owner: { attached: boolean; ownerChange: number | null; targetKey: string }
}): void {
  const { outbox, owner, sessionId, submissions } = args
  const probeAttemptsRef = useRef({ id: null as string | null, attempts: 0 })
  useLayoutEffect(() => {
    probeAttemptsRef.current = { id: null, attempts: 0 }
  }, [owner.ownerChange, owner.targetKey, sessionId])

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
  // never been retried, and that no Stop outlived, are safe to probe automatically.
  // The delivery notices read the same rule: while it is resent here, its row says it is sending.
  const probeId =
    blocker &&
    blocker.sessionId === sessionId &&
    structuredAgentSessionEntryResendsUnconfirmed(blocker, submissions)
      ? blocker.clientMessageId
      : null
  useEffect(() => {
    if (probeId === null || !owner.attached) {
      return
    }
    const attempts = probeAttemptsRef.current.id === probeId ? probeAttemptsRef.current.attempts : 0
    const timer = setTimeout(
      () => {
        probeAttemptsRef.current = { id: probeId, attempts: attempts + 1 }
        const next = getStructuredAgentSessionOutbox(sessionId).map((entry) => {
          if (entry.clientMessageId !== probeId) {
            return entry
          }
          // A saved failure would hold it for a Retry instead of resending it.
          const { lastFailure: _probed, ...probed } = entry
          return { ...probed, state: 'queued' as const }
        })
        commitStructuredAgentSessionOutbox(sessionId, next)
      },
      Math.min(UNCONFIRMED_PROBE_BASE_DELAY_MS * 2 ** attempts, UNCONFIRMED_PROBE_MAX_DELAY_MS)
    )
    return () => clearTimeout(timer)
  }, [owner.attached, owner.ownerChange, owner.targetKey, probeId, sessionId])
}
