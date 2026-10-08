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
import {
  agentSessionUnconfirmedSendParts,
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  attemptStructuredAgentSessionSend,
  forgetStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from './structured-agent-session-send-attempt'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { nativeChatRewindReasonCopy } from './native-chat-rewind-copy'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import {
  takeStructuredAgentSessionSendSlot,
  type StructuredAgentSessionSendInput
} from './structured-agent-session-send-slot'
import {
  clearStructuredAgentSessionPendingSends,
  findStructuredAgentSessionPendingSend,
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  structuredAgentSessionSendsWatched,
  structuredAgentSessionsWithPendingSends,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

/** From the moment a message is sent: past it, the message goes back to the composer, saying it
 *  was not sent if it never went out, and that nobody could confirm it if it did. */
export const STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS = 30_000

/** `returned`: back in the composer, not sent. `unconfirmed`: back in the composer, though the host
 *  may hold it. */
export type StructuredAgentSessionSendOutcome = 'recorded' | 'returned' | 'unconfirmed' | 'dropped'

type SendRuntime = {
  target: RuntimeClientTarget
  abort: AbortController
  deadline: ReturnType<typeof setTimeout>
  resolve: (outcome: StructuredAgentSessionSendOutcome) => void
}

const runtimes = new Map<string, SendRuntime>()

/** Ends a send for good: the entry leaves (or stays as `recorded`) and its caller is answered. */
function finish(
  entry: StructuredAgentSessionPendingSend,
  outcome: StructuredAgentSessionSendOutcome,
  keep?: Partial<StructuredAgentSessionPendingSend>
): void {
  const runtime = runtimes.get(entry.clientMessageId)
  if (runtime) {
    clearTimeout(runtime.deadline)
    runtimes.delete(entry.clientMessageId)
    runtime.resolve(outcome)
  }
  updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, keep ?? null)
}

/** Puts the text back in the chat's composer; false, reported, when the draft write threw. */
function returnToComposer(entry: StructuredAgentSessionPendingSend): boolean {
  try {
    handBackStructuredAgentSessionMessage(
      entry.sessionId,
      entry.clientMessageId,
      entry.body,
      entry.imageConnectionIds
    )
    return true
  } catch (error) {
    console.error('[native-chat-send] a message could not be put back in the composer', error)
    return false
  }
}

function handBack(
  entry: StructuredAgentSessionPendingSend,
  notice: readonly AgentSessionWriteNoticePart[] | null
): void {
  try {
    if (entry.callerKeepsText) {
      return
    }
    const parts: readonly AgentSessionWriteNoticePart[] | null = returnToComposer(entry)
      ? notice
      : [...(notice ?? []), 'messageNotSaved']
    if (parts) {
      publishStructuredAgentSessionSends(entry.sessionId, {
        notice: agentSessionWriteNoticeText([...parts])
      })
    }
  } finally {
    // Bookkeeping never holds the chat: whatever the hand-back met, the send ends.
    finish(entry, notice?.includes('sendOutcomeLost') ? 'unconfirmed' : 'returned')
  }
}

/** Settled by the host's answer, from the send's own reply or the journal, whichever comes first. */
function settleRecorded(
  entry: StructuredAgentSessionPendingSend,
  submission: AgentJournalSubmission | null,
  from: 'reply' | 'journal'
): void {
  // A message a Stop took back stays in the chat with its stop row, drawn by the host's row; the
  // composer is left alone. An open chat draws a recorded one until its row arrives, which can
  // trail the reply.
  const keep =
    from === 'reply' &&
    !(submission && dispatchWasWithdrawn(submission)) &&
    structuredAgentSessionSendsWatched(entry.sessionId)
  finish(entry, 'recorded', keep ? { phase: 'recorded', issued: true } : undefined)
}

/** Why the host turned the send away. Behind a rewind whose outcome is unknown it was not sent: the
 *  rewind's words say why, and the next send has the host check it first. */
function refusedSendParts(failure: AgentSessionWriteFailure): AgentSessionWriteNoticePart[] {
  return failure.kind === 'refused' && failure.details?.reason === 'rewindUnconfirmed'
    ? [
        { text: nativeChatRewindReasonCopy('outcome-unknown') },
        ...agentSessionWriteNotDoneParts('composer-send')
      ]
    : agentSessionWriteNoticeParts(failure, 'composer-send')
}

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

function onDeadline(sessionId: string, clientMessageId: string): void {
  const entry = findStructuredAgentSessionPendingSend(sessionId, clientMessageId)
  if (!entry || entry.phase === 'recorded') {
    return
  }
  runtimes.get(clientMessageId)?.abort.abort()
  // One that went out may still land: its row then shows it beside the text given back.
  handBack(
    entry,
    entry.issued
      ? ['sendOutcomeLost']
      : ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')]
  )
}

export type StructuredAgentSessionSent = {
  clientMessageId: string
  outcome: Promise<StructuredAgentSessionSendOutcome>
}

/** Sends a message holding its chat's slot; its 30 s start now. */
function dispatch(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget
): StructuredAgentSessionSent {
  const { clientMessageId, sessionId } = entry
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    runtimes.set(clientMessageId, {
      target,
      abort: new AbortController(),
      deadline: setTimeout(
        () => onDeadline(sessionId, clientMessageId),
        STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS
      ),
      resolve
    })
  })
  void attempt(entry)
  return { clientMessageId, outcome }
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
  /** Sends it once the chat exists; null when the reservation was released or dropped meanwhile. */
  send: (target: RuntimeClientTarget) => StructuredAgentSessionSent | null
  /** Gives the slot back unsent. */
  release: () => void
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
  const held = (): StructuredAgentSessionPendingSend | undefined =>
    sent ? undefined : findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  return {
    send: (target) => {
      const current = held()
      sent = true
      return current ? dispatch(current, target) : null
    },
    release: () => {
      if (held()) {
        updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, null)
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
