import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import {
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
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
  activity: ReturnType<ReturnType<typeof getStructuredAgentSessionReadOwner>['trackSend']>
  target: RuntimeClientTarget
  abort: AbortController
  deadline: ReturnType<typeof setTimeout> | null
  resolve: (outcome: StructuredAgentSessionSendOutcome) => void
  beforeFinish?: (outcome: StructuredAgentSessionSendOutcome) => void
}

export const runtimes = new Map<string, SendRuntime>()

export function finish(
  entry: StructuredAgentSessionPendingSend,
  outcome: StructuredAgentSessionSendOutcome,
  keep?: Partial<StructuredAgentSessionPendingSend>
): void {
  const runtime = runtimes.get(entry.clientMessageId)
  if (runtime) {
    runtime.activity.settle(outcome === 'unconfirmed')
    if (runtime.deadline !== null) {
      clearTimeout(runtime.deadline)
    }
    runtimes.delete(entry.clientMessageId)
    try {
      runtime.beforeFinish?.(outcome)
    } catch (error) {
      console.error('[native-chat-send] settlement observer failed', error)
    }
    runtime.resolve(outcome)
    if (
      runtime.beforeFinish &&
      !findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
    ) {
      return
    }
  }
  updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, keep ?? null)
}

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
  from: 'reply' | 'journal',
  cursor?: AgentJournalCursor | null
): void {
  // Stop-withdrawn messages stay in host history; otherwise retain recorded echoes until rows catch up with replies.
  const keep =
    from === 'reply' &&
    !(submission && dispatchWasWithdrawn(submission)) &&
    structuredAgentSessionSendsWatched(entry.sessionId)
  finish(
    entry,
    'recorded',
    keep
      ? { phase: 'recorded', issued: true, ...(cursor ? { recordedCursor: cursor } : {}) }
      : undefined
  )
}

/** Unconfirmed rewind blocks sends until the host checks it again; use the rewind-specific refusal words. */
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

/** Holds the send's runtime; deferred creates start their budget only at an actual target. */
export function beginSend(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget,
  budgetMs: number | null = STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS,
  beforeFinish?: SendRuntime['beforeFinish']
): StructuredAgentSessionSent {
  const { clientMessageId, sessionId } = entry
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    runtimes.set(clientMessageId, {
      activity: getStructuredAgentSessionReadOwner(sessionId, target).trackSend(clientMessageId),
      target,
      abort: new AbortController(),
      deadline:
        budgetMs === null
          ? null
          : setTimeout(() => onDeadline(sessionId, clientMessageId), budgetMs),
      resolve,
      beforeFinish
    })
  })
  return { clientMessageId, outcome }
}

/** The caller has proved the actual target; start its ordinary budget at most once. */
export function activateSend(entry: StructuredAgentSessionPendingSend): void {
  const runtime = runtimes.get(entry.clientMessageId)
  if (runtime && runtime.deadline === null) {
    runtime.deadline = setTimeout(
      () => onDeadline(entry.sessionId, entry.clientMessageId),
      STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS
    )
  }
}
