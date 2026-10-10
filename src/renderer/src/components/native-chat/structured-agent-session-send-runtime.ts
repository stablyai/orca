import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { nativeChatRewindReasonCopy } from './native-chat-rewind-copy'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import {
  findStructuredAgentSessionPendingSend,
  publishStructuredAgentSessionSends,
  structuredAgentSessionSendsWatched,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

export const STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS = 30_000

export type StructuredAgentSessionSendOutcome = 'recorded' | 'returned' | 'unconfirmed' | 'dropped'

type SendRuntime = {
  target: RuntimeClientTarget
  abort: AbortController
  deadline: ReturnType<typeof setTimeout>
  resolve: (outcome: StructuredAgentSessionSendOutcome) => void
}

export const runtimes = new Map<string, SendRuntime>()

/** Ends a send for good: the entry leaves (or stays as `recorded`) and its caller is answered. */
export function finish(
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

export function handBack(
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
export function settleRecorded(
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
export function refusedSendParts(failure: AgentSessionWriteFailure): AgentSessionWriteNoticePart[] {
  return failure.kind === 'refused' && failure.details?.reason === 'rewindUnconfirmed'
    ? [
        { text: nativeChatRewindReasonCopy('outcome-unknown') },
        ...agentSessionWriteNotDoneParts('composer-send')
      ]
    : agentSessionWriteNoticeParts(failure, 'composer-send')
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
export function beginSend(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget,
  budgetMs = STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS
): StructuredAgentSessionSent {
  const { clientMessageId, sessionId } = entry
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    runtimes.set(clientMessageId, {
      target,
      abort: new AbortController(),
      deadline: setTimeout(() => onDeadline(sessionId, clientMessageId), budgetMs),
      resolve
    })
  })
  return { clientMessageId, outcome }
}
