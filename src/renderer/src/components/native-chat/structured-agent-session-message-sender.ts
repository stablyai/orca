// The one way a structured chat message reaches its host: composer, launch prompt and a message sent
// from outside the chat all call `sendStructuredAgentSessionMessage`, with or without the chat's view
// mounted. The host's journal and queue own every message they hold. This module keeps, in memory
// only, the one send per chat the host has not answered yet: for its "Sending…" bubble, and to put
// the message back in the composer when the host did not take it, or nobody can say. While it is
// out the chat takes no other send, which keeps the host's arrival order without a client line.
//
// Nothing here is saved, nothing outlives one deadline, and nothing is ever sent twice: a send makes
// one request, and whatever its answer, nothing sends it again.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionFirstMessage } from '../../../../shared/structured-agent-session-create'
import {
  agentSessionUnconfirmedSendParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
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

/** The send's one request, and what its answer settles. Nothing is ever sent again. */
async function attempt(entry: StructuredAgentSessionPendingSend): Promise<void> {
  const runtime = runtimes.get(entry.clientMessageId)
  if (!runtime) {
    return
  }
  const outcome = await attemptStructuredAgentSessionSend({
    entry,
    target: runtime.target,
    beforeIssue: () =>
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
        issued: true
      }),
    abandoned: () => runtime.abort.signal.aborted || runtimes.get(entry.clientMessageId) !== runtime
  })
  const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  if (!outcome || !current) {
    return
  }
  if (outcome.kind === 'not-sent') {
    handBack(current, outcome.parts)
  } else if (outcome.evidence.kind === 'recorded') {
    settleRecorded(current, outcome.submission, 'reply')
  } else if (outcome.evidence.kind === 'not-recorded') {
    handBack(current, refusedSendParts(outcome.evidence.failure))
  } else {
    // Dropped, unanswered, or an answer that proves nothing: it may have landed, so check first.
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

/**
 * Sends one message, or returns null while another send of its chat is out. Resolves once its fate
 * is known here: `recorded` (the host holds it), `returned` or `unconfirmed` (it went back to the
 * composer, with the reason on the chat's line), or `dropped` (its launch was cancelled or its
 * worktree purged).
 */
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
  /** Gives the slot back unsent. */
  release: () => void
}

export type StructuredAgentSessionCreateSend = StructuredAgentSessionSent & {
  message: StructuredAgentSessionFirstMessage
  settle: (
    result:
      | { kind: 'recorded'; submission: AgentJournalSubmission }
      | { kind: 'refused'; failure?: AgentSessionWriteFailure }
      | { kind: 'unconfirmed' }
  ) => void
}

/**
 * A launch's prompt holds its chat's one send from the click: drawn as sending, so nothing typed
 * meanwhile overtakes it, and sent once the chat exists. Null while the chat already has a send out.
 */
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
      void sending.outcome.then(settleReservation)
      updateStructuredAgentSessionPendingSend(current.sessionId, current.clientMessageId, {
        issued: true
      })
      return {
        ...sending,
        message: { clientMessageId: current.clientMessageId, body: current.body },
        settle: (result) => {
          const pending = findStructuredAgentSessionPendingSend(
            current.sessionId,
            current.clientMessageId
          )
          if (!pending || pending.phase === 'recorded' || !runtimes.has(current.clientMessageId)) {
            return
          }
          if (result.kind === 'recorded') {
            settleRecorded(pending, result.submission, 'reply')
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

/**
 * Settles sends from the host's published state: a row under the message's id, a hand-off of a card
 * under it, or a card under it. Whichever of this and the send's own reply comes first decides.
 */
export function settleStructuredAgentSessionSendsFromJournal(
  sessionId: string,
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[]
): void {
  const entries = getStructuredAgentSessionPendingSends(sessionId)
  if (entries.length === 0) {
    return
  }
  const cards = new Set(queuedMessageIds)
  for (const submission of submissions) {
    if (submission.queuedMessageId !== undefined) {
      cards.add(submission.queuedMessageId)
    }
  }
  const rows = new Map(submissions.map((submission) => [submission.clientMessageId, submission]))
  for (const entry of entries) {
    const submission = rows.get(entry.clientMessageId)
    if (cards.has(entry.clientMessageId)) {
      finish(entry, 'recorded')
    } else if (submission) {
      settleRecorded(entry, submission, 'journal')
    }
  }
}

/**
 * A Stop, or the chat's tab closing: a send still being readied never went out, so it goes back
 * silently and nothing is sent; one whose request is out settles from its answer.
 */
export function stopStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    if (runtime && !entry.issued) {
      runtime.abort.abort()
      handBack(entry, null)
    }
  }
}

/** A cancelled launch or a purged worktree: its sends are dropped, and their callers told so. */
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
  for (const sessionId of structuredAgentSessionsWithPendingSends()) {
    publishStructuredAgentSessionSends(sessionId, { holds: 0 })
    dropStructuredAgentSessionSends(sessionId)
  }
  resetStructuredAgentSessionFencesForTests()
}
