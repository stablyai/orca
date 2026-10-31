// Sidebar request/verdict/preview share this read: a turn or refused send is a request; steers belong to their turn, and commands are not requests.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle,
  AgentJournalTurnLifecycleState,
  AgentJournalTurnOutcome
} from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import { withoutNativeChatVisualDirectiveLines } from './native-chat/native-chat-visual-directive'
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
  /** The turn's lifecycle state: what the host observed of it. Null for a refused send. */
  turnState: AgentJournalTurnLifecycleState | null
  /** The provider's verdict. Null while the turn runs, and for a turn whose end carried none. */
  outcome: AgentJournalTurnOutcome | null
  /** When it settled: the turn's end, or the refusal. Undefined while it runs. */
  settledAt: number | undefined
}

/** Commands and steers have no independent request; their turns own any response. */
export function isStructuredAgentSessionNonRequestRow(
  item: Pick<AgentJournalRenderItem, 'itemId' | 'body' | 'turnScope'>,
  commandTurnItemIds: ReadonlySet<string>
): boolean {
  return (
    commandTurnItemIds.has(item.itemId) ||
    isStructuredAgentSessionCommandRow(item, commandTurnItemIds) ||
    (item.body.kind === 'message' && item.body.role === 'user' && item.turnScope?.kind === 'turn')
  )
}

/** Skip accepted/unanswered sends and nonfailures (withdrawal/restart/close); null when no request has a verdict. */
export function latestStructuredAgentSessionRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): StructuredAgentSessionLatestRequest | null {
  const rejected = rejectedSubmissionsByItem(submissions)
  const commandTurns = structuredAgentSessionCommandTurnItemIds(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    // Commands retain the last real request’s verdict.
    if (
      !item ||
      !isRootAgentJournalItem(item) ||
      isStructuredAgentSessionNonRequestRow(item, commandTurns)
    ) {
      continue
    }
    if (
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      item.turnScope?.kind === 'unknown'
    ) {
      return null
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn) {
      return {
        kind: 'turn',
        id: turn.turnId,
        turnState: turn.state,
        outcome: readAgentJournalTurnOutcome(turn),
        settledAt: turn.state === 'running' ? undefined : turnEndedAt(item, turn)
      }
    }
    const submission = rejected.get(item.itemId)
    // Rejection relocates a refused steer to the thread, but its turn remains the request.
    if (
      submission &&
      submission.answeredInTurn?.via !== 'steer' &&
      classifyDispatchRejection(submission).verdict === 'failure'
    ) {
      return {
        kind: 'refused-send',
        id: item.itemId,
        turnState: null,
        outcome: 'failure',
        settledAt: submission.resolvedAt ?? submission.submittedAt
      }
    }
  }
  return null
}

/** Exclude sends that failed nobody and never became turns; include provider-journaled user rows, even from children/history/old hosts. */
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
          classifyDispatchRejection(submission).verdict === 'failure')
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

/** Recovery dates its own settle; older provider ends without clocks use their turn publication. */
function turnEndedAt(
  item: AgentJournalRenderItem,
  turn: AgentJournalTurnLifecycle
): number | undefined {
  return item.recoveredAt ?? turn.completedAt ?? item.observedAt
}

function messageProse(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Root user prompts only; child prompts share this journal but must not become the session preview. */
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

/** Newest root-agent prose in the latest user turn; skip child/tool-only output and clear at the user boundary. */
export function latestStructuredAgentSessionAssistantMessage(
  items: readonly AgentJournalRenderItem[]
): string {
  const commandTurns = structuredAgentSessionCommandTurnItemIds(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const body = item?.body
    if (!isRootAgentJournalItem(item) || isStructuredAgentSessionCommandRow(item, commandTurns)) {
      continue
    }
    if (body?.kind === 'message' && body.role === 'user') {
      return ''
    }
    if (body?.kind === 'message' && body.role === 'assistant') {
      // Visual directives belong only in the transcript, not plain-text previews.
      const prose = withoutNativeChatVisualDirectiveLines(messageProse(body.blocks))
      if (prose.trim()) {
        return prose
      }
    }
  }
  return ''
}
