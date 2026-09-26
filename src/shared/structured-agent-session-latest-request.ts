// The session's latest request and what became of it: the verdict a sidebar row reports once
// the session is idle, whether there is a request to list at all, and the prompt and answer its row
// quotes.
//
// A request is either a turn, whose record carries the provider's verdict, or a send that never
// became one because the agent or its start refused it. A send its handover placed inside a
// running turn (a steer) is not a request of its own: the turn it joined answers for it. Nor is a
// conversation command.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle,
  AgentJournalTurnOutcome
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { dispatchRejectionVerdict } from './structured-agent-session-dispatch-rejection'
import { isUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'
import {
  isStructuredAgentSessionCommandEntry,
  isStructuredAgentSessionCommandRow,
  structuredAgentSessionCommandTurnItemIds
} from './structured-agent-session-command-entry'
import type { NativeChatBlock } from './native-chat-types'

export type StructuredAgentSessionLatestRequest = {
  kind: 'turn' | 'refused-send'
  /** The turn's id, or the refused send's journal item key. Unique only within its kind. */
  id: string
  running: boolean
  /** Null while the turn runs, and for a turn whose end carried no verdict. */
  outcome: AgentJournalTurnOutcome | null
  /** When it settled: the turn's end, or the refusal. Undefined while it runs. */
  settledAt: number | undefined
}

/** Null when the journal holds no request with a verdict to give. Accepted and unanswered sends
 *  are passed over — the session is working until their turn records — and so are sends that
 *  failed nobody (withdrawn, or left undelivered by a restart or a close). */
export function latestStructuredAgentSessionRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionLatestRequest | null {
  const rejected = rejectedSubmissionsByItem(submissions)
  const commandTurns = structuredAgentSessionCommandTurnItemIds(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    // A conversation command is not a request: the verdict stays the last real request's.
    if (
      !item ||
      !isRootAgentJournalItem(item) ||
      commandTurns.has(item.itemId) ||
      isStructuredAgentSessionCommandEntry(item.body)
    ) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      const running = turn.state === 'running'
      return {
        kind: 'turn',
        id: turn.turnId,
        running,
        outcome: readAgentJournalTurnOutcome(turn),
        settledAt: running ? undefined : turnEndedAt(item, turn)
      }
    }
    const submission = rejected.get(item.itemId)
    if (
      submission &&
      dispatchRejectionVerdict(submission.reason) === 'failure' &&
      // Handed into a running turn (a steer): that turn answers for it.
      item.turnScope?.kind !== 'turn'
    ) {
      return {
        kind: 'refused-send',
        id: item.itemId,
        running: false,
        outcome: 'failure',
        settledAt: submission.resolvedAt ?? undefined
      }
    }
  }
  return null
}

/** Whether the session has a request to list. A send that failed nobody and never became a turn
 *  leaves nothing to report, so a session holding only those is not listed; a user message the
 *  provider journaled itself (history, an older host) still is. Deliberately NOT scoped by
 *  producer: a session whose only content came from a subagent still has content. */
export function hasStructuredAgentSessionRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  const sent = new Set(
    submissions.map((submission) => agentJournalSubmissionKey(submission.clientMessageId))
  )
  return (
    items.some(
      (item) =>
        readAgentJournalTurn(item.body) !== null ||
        (item.body.kind === 'message' &&
          (item.body.role === 'assistant' || (item.body.role === 'user' && !sent.has(item.itemId))))
    ) ||
    submissions.some(
      (submission) =>
        submission.dispatchState === 'accepted' ||
        isUnansweredStructuredAgentSessionDispatch(submission, currentFence) ||
        (submission.dispatchState === 'rejected' &&
          dispatchRejectionVerdict(submission.reason) === 'failure')
    )
  )
}

function rejectedSubmissionsByItem(
  submissions: readonly AgentJournalSubmission[]
): Map<string, AgentJournalSubmission> {
  const rejected = new Map<string, AgentJournalSubmission>()
  for (const submission of submissions) {
    if (submission.dispatchState === 'rejected') {
      rejected.set(agentJournalSubmissionKey(submission.clientMessageId), submission)
    }
  }
  return rejected
}

/** A turn recovery settled ended when that settle was written: when the user learns it stopped. */
function turnEndedAt(
  item: AgentJournalRenderItem,
  turn: AgentJournalTurnLifecycle
): number | undefined {
  return item.recoveredAt ?? turn.completedAt
}

function messageProse(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** The newest prompt the session's own user turn carries, as the sidebar quotes
 *  it. Scoped to root rows for the same reason the assistant line is: a provider
 *  that journals a subagent's own prompt would otherwise requote it as the
 *  session's. */
export function latestStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): string {
  const body = latestStructuredAgentSessionUserItem(items)?.body
  return body?.kind === 'message' ? messageProse(body.blocks) : ''
}

export function latestStructuredAgentSessionUserItem(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item?.body.kind === 'message' &&
      item.body.role === 'user' &&
      isRootAgentJournalItem(item) &&
      !isStructuredAgentSessionCommandEntry(item.body)
    ) {
      return item
    }
  }
  return null
}

/** The newest prose THE SESSION'S OWN AGENT wrote in the latest user turn — not a
 *  subagent's, whose rows share this journal and are usually the newer ones while
 *  a child runs. Tool-only assistant items are skipped; the user boundary clears
 *  prose from the preceding turn. */
export function latestStructuredAgentSessionAssistantMessage(
  items: readonly AgentJournalRenderItem[]
): string {
  const commandTurns = structuredAgentSessionCommandTurnItemIds(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    // A command and what its turn produced are not the conversation's latest answer.
    if (!isRootAgentJournalItem(item) || isStructuredAgentSessionCommandRow(item, commandTurns)) {
      continue
    }
    if (body?.kind === 'message' && body.role === 'user') {
      return ''
    }
    if (body?.kind === 'message' && body.role === 'assistant') {
      const prose = messageProse(body.blocks)
      if (prose.trim()) {
        return prose
      }
    }
  }
  return ''
}
