import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'

const UNCONFIRMED_PROBE_BASE_DELAY_MS = 1_000
/** No attempt ceiling: a transport outage outlives any fixed budget, and giving up
 *  restores the wedge this fixes. Growth caps the rate at one status query per 16s.
 *  A refusal that blocks the head still ends probing until a manual Retry (or, on an older
 *  host, a fence change), because the entry leaves `unconfirmed`. */
const UNCONFIRMED_PROBE_MAX_DELAY_MS = 16_000

/** Re-queues the entry holding the outbox in `unconfirmed`, with backoff, until the journal answers it. */
export function useStructuredAgentSessionOutboxUnconfirmedProbe(args: {
  sessionId: string
  outbox: readonly StructuredAgentSessionOutboxEntry[]
  submissions: readonly AgentJournalSubmission[]
  owner: { attached: boolean; ownerChange: number | null; targetKey: string }
  outboxRef: { current: StructuredAgentSessionOutboxEntry[] }
  setOutbox: Dispatch<SetStateAction<StructuredAgentSessionOutboxEntry[]>>
}): void {
  const { outbox, outboxRef, owner, sessionId, setOutbox, submissions } = args
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
  }, [
    outboxRef,
    owner.attached,
    owner.ownerChange,
    owner.targetKey,
    probeId,
    probeSettled,
    sessionId,
    setOutbox
  ])
}
