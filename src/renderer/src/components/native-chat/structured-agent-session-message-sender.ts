// Allow one unanswered send per chat in memory; host rows/cards own admitted messages. Never retry a send or retain it past its deadline.

import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionFirstMessage } from '../../../../shared/structured-agent-session-create'
import {
  agentSessionUnconfirmedSendParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import {
  structuredAgentSessionReadCoversSend,
  structuredAgentSessionSettledSends
} from '../../../../shared/structured-agent-session-send-settlement'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import {
  attemptStructuredAgentSessionSend,
  forgetStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from './structured-agent-session-send-attempt'
import {
  takeStructuredAgentSessionSendSlot,
  type StructuredAgentSessionSendInput
} from './structured-agent-session-send-slot'
import {
  clearStructuredAgentSessionPendingSends,
  findStructuredAgentSessionPendingSend,
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  structuredAgentSessionsWithPendingSends,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'
import {
  beginSend,
  finish,
  handBack,
  refusedSendParts,
  runtimes,
  settleRecorded,
  STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS,
  type StructuredAgentSessionSendOutcome,
  type StructuredAgentSessionSent
} from './structured-agent-session-send-runtime'
export { STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS } from './structured-agent-session-send-runtime'
export type {
  StructuredAgentSessionSendOutcome,
  StructuredAgentSessionSent
} from './structured-agent-session-send-runtime'

async function attempt(entry: StructuredAgentSessionPendingSend): Promise<void> {
  const runtime = runtimes.get(entry.clientMessageId)
  if (!runtime) {
    return
  }
  const outcome = await attemptStructuredAgentSessionSend({
    entry,
    target: runtime.target,
    reconcile: runtime.activity.settle,
    beforeIssue: () => {
      runtime.activity.issue()
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
        issued: true
      })
    },
    abandoned: () => runtime.abort.signal.aborted || runtimes.get(entry.clientMessageId) !== runtime
  })
  const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  if (!outcome || !current) {
    return
  }
  if (outcome.kind === 'not-sent') {
    handBack(current, outcome.parts)
  } else if (outcome.evidence.kind === 'recorded') {
    settleRecorded(current, outcome.submission, 'reply', outcome.cursor)
  } else if (outcome.evidence.kind === 'not-recorded') {
    handBack(current, refusedSendParts(outcome.evidence.failure))
  } else {
    // An uncertain request may have landed; return its text with an unconfirmed notice and never resend automatically.
    handBack(current, agentSessionUnconfirmedSendParts(outcome.thrownRefusal))
  }
}

function dispatch(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget
): StructuredAgentSessionSent {
  const sent = beginSend(entry, target)
  void attempt(entry)
  return sent
}

/** Reserve one chat send; resolve as recorded, returned, unconfirmed or dropped, and return null while another is outstanding. */
export function sendStructuredAgentSessionMessage(
  input: StructuredAgentSessionSendInput & { target: RuntimeClientTarget }
): StructuredAgentSessionSent | null {
  const entry = takeStructuredAgentSessionSendSlot(input)
  return entry ? dispatch(entry, input.target) : null
}

export type StructuredAgentSessionReservedSend = {
  outcome: Promise<StructuredAgentSessionSendOutcome>
  /** Older creates wait for acquisition; their send budget still begins at send. */
  legacy: () => void
  /** Sends it once the chat exists; null when the reservation was released or dropped meanwhile. */
  send: (target: RuntimeClientTarget) => StructuredAgentSessionSent | null
  /** The same message, owned by create instead of a later send request. */
  create: (target: RuntimeClientTarget) => StructuredAgentSessionCreateSend | null
  release: () => void
}

export type StructuredAgentSessionCreateSend = StructuredAgentSessionSent & {
  message: StructuredAgentSessionFirstMessage
  settle: (
    result:
      | { kind: 'recorded'; submission: AgentJournalSubmission; cursor?: AgentJournalCursor }
      | { kind: 'refused'; failure?: AgentSessionWriteFailure }
      | { kind: 'unconfirmed' }
  ) => void
}

/** Reserve the launch prompt at click time so later typing cannot overtake it before chat creation. */
export function reserveStructuredAgentSessionSend(
  input: StructuredAgentSessionSendInput
): StructuredAgentSessionReservedSend | null {
  const entry = takeStructuredAgentSessionSendSlot(input)
  if (!entry) {
    return null
  }
  // Once sent, the entry is the send's: what it keeps after settling is not the reservation's.
  let sent = false
  let settleReservation = (_outcome: StructuredAgentSessionSendOutcome): void => {}
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    settleReservation = resolve
  })
  const held = (): StructuredAgentSessionPendingSend | undefined =>
    sent ? undefined : findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  const deadline = setTimeout(() => {
    const current = held()
    if (current) {
      handBack(current, ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')])
      settleReservation('returned')
    }
  }, STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
  return {
    outcome,
    legacy: () => clearTimeout(deadline),
    send: (target) => {
      const current = held()
      sent = true
      clearTimeout(deadline)
      const sending = current ? dispatch(current, target) : null
      if (sending) {
        void sending.outcome.then(settleReservation)
      }
      return sending
    },
    create: (target) => {
      const current = held()
      if (!current) {
        return null
      }
      sent = true
      clearTimeout(deadline)
      const remaining = STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS - (Date.now() - current.queuedAt)
      if (remaining <= 0) {
        handBack(current, ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')])
        settleReservation('returned')
        return null
      }
      const sending = beginSend(current, target, remaining)
      const activity = runtimes.get(current.clientMessageId)?.activity
      activity?.issue()
      void sending.outcome.then(settleReservation)
      updateStructuredAgentSessionPendingSend(current.sessionId, current.clientMessageId, {
        issued: true
      })
      return {
        ...sending,
        message: { clientMessageId: current.clientMessageId, body: current.body },
        settle: (result) => {
          activity?.settle(result.kind === 'unconfirmed')
          const pending = findStructuredAgentSessionPendingSend(
            current.sessionId,
            current.clientMessageId
          )
          if (!pending || pending.phase === 'recorded' || !runtimes.has(current.clientMessageId)) {
            return
          }
          if (result.kind === 'recorded') {
            settleRecorded(pending, result.submission, 'reply', result.cursor)
          } else {
            handBack(
              pending,
              result.kind === 'unconfirmed'
                ? agentSessionUnconfirmedSendParts(undefined)
                : result.failure
                  ? refusedSendParts(result.failure)
                  : agentSessionWriteNotDoneParts('composer-send')
            )
          }
        }
      }
    },
    release: () => {
      clearTimeout(deadline)
      if (held()) {
        updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, null)
        settleReservation('dropped')
      }
    }
  }
}

export function settleStructuredAgentSessionSendsFromJournal(
  sessionId: string,
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[],
  cursor?: AgentJournalCursor | null
): void {
  const entries = getStructuredAgentSessionPendingSends(sessionId)
  if (entries.length === 0) {
    return
  }
  const { cards, recorded } = structuredAgentSessionSettledSends(submissions, queuedMessageIds)
  for (const entry of entries) {
    const submission = recorded.get(entry.clientMessageId)
    if (
      cards.has(entry.clientMessageId) ||
      (entry.phase === 'recorded' &&
        structuredAgentSessionReadCoversSend(cursor, entry.recordedCursor))
    ) {
      finish(entry, 'recorded')
    } else if (submission) {
      settleRecorded(entry, submission, 'journal')
    }
  }
}

/** Stop returns unissued sends silently; issued requests settle from their answer without retry. */
export function stopStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    if (runtime && !entry.issued) {
      runtime.abort.abort()
      handBack(entry, null)
    }
  }
}

export function dropStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    runtime?.abort.abort()
    if (runtime) {
      clearTimeout(runtime.deadline)
      runtimes.delete(entry.clientMessageId)
      runtime.resolve('dropped')
    }
  }
  forgetStructuredAgentSessionFence(sessionId)
  clearStructuredAgentSessionPendingSends(sessionId)
}

export function resetStructuredAgentSessionSendsForTests(): void {
  resetStructuredAgentSessionReadOwnersForTests()
  for (const sessionId of structuredAgentSessionsWithPendingSends()) {
    publishStructuredAgentSessionSends(sessionId, { holds: 0 })
    dropStructuredAgentSessionSends(sessionId)
  }
  resetStructuredAgentSessionFencesForTests()
}
