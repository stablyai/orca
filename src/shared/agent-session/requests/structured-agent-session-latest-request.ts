import { structuredAgentSessionCommandTurnItemIdsSteps } from '../structured-agent-session-command-entry'
import { finishAgentSessionSteps } from '../agent-session-projection-steps'
// Sidebar request/verdict/preview share this read: a turn or refused send is a request; steers belong to their turn, and commands are not requests.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle,
  AgentJournalTurnLifecycleState
} from '../journal/agent-session-journal-types'
import type { AgentJournalTurnOutcome } from '../../agent-status/lifecycle/agent-turn-outcome'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../lifecycle/agent-session-turn-record'
import { classifyDispatchRejection } from './structured-agent-session-dispatch-rejection'
import { withoutNativeChatVisualDirectiveLines } from '../../native-chat/native-chat-visual-directive'
import { isUnansweredStructuredAgentSessionDispatch } from './structured-agent-session-unanswered-dispatch'
import {
  isStructuredAgentSessionCommandEntry,
  isStructuredAgentSessionCommandRow
} from '../structured-agent-session-command-entry'
import type { NativeChatBlock } from '../../native-chat/native-chat-types'

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
  /** The agent opened this turn itself (e.g. woken by a background task) and the user steered nothing into it. */
  selfStarted?: true
}

/** Commands and steers have no independent request; their turns own any response. */
export function isStructuredAgentSessionNonRequestRow(
  item: Pick<AgentJournalRenderItem, 'itemId' | 'body' | 'turnScope'>,
  commandTurnItemIds: Pick<ReadonlySet<string>, 'has'>
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
  return finishAgentSessionSteps(latestStructuredAgentSessionRequestSteps(items, submissions))
}

export function* latestStructuredAgentSessionRequestSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): Generator<void, StructuredAgentSessionLatestRequest | null> {
  const rejected = yield* rejectedSubmissionsByItemSteps(submissions)
  const commandTurns = yield* structuredAgentSessionCommandTurnItemIdsSteps(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    yield

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
        settledAt: turn.state === 'running' ? undefined : turnEndedAt(item, turn),
        ...(turn.userItemId === item.itemId && !(yield* steeredIntoSteps(submissions, item.itemId))
          ? { selfStarted: true as const }
          : {})
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

/** A user message steered into a turn the agent started makes it the user's turn too. */
function* steeredIntoSteps(
  submissions: readonly AgentJournalSubmission[],
  turnItemId: string
): Generator<void, boolean> {
  for (const { answeredInTurn } of submissions) {
    yield
    if (answeredInTurn?.via === 'steer' && answeredInTurn.turnItemId === turnItemId) {
      return true
    }
  }
  return false
}

/** Exclude sends that failed nobody and never became turns; include provider-journaled user rows, even from children/history/old hosts. */
export function hasStructuredAgentSessionRequest(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): boolean {
  return finishAgentSessionSteps(
    hasStructuredAgentSessionRequestSteps(items, submissions, currentFence)
  )
}

export function* hasStructuredAgentSessionRequestSteps(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[],
  currentFence?: number | null
): Generator<void, boolean> {
  const sent = new Set<string>()
  for (const submission of submissions) {
    sent.add(agentJournalSubmissionKey(submission.clientMessageId))
    yield
  }
  for (const item of items) {
    yield
    if (
      readAgentJournalTurn(item.body) !== null ||
      (item.body.kind === 'message' &&
        (item.body.role === 'assistant' || (item.body.role === 'user' && !sent.has(item.itemId))))
    ) {
      return true
    }
  }
  for (const submission of submissions) {
    yield
    if (
      submission.dispatchState === 'accepted' ||
      isUnansweredStructuredAgentSessionDispatch(submission, currentFence) ||
      (submission.dispatchState === 'rejected' &&
        classifyDispatchRejection(submission).verdict === 'failure')
    ) {
      return true
    }
  }
  return false
}

export function* rejectedSubmissionsByItemSteps(
  submissions: readonly AgentJournalSubmission[]
): Generator<void, Map<string, AgentJournalSubmission>> {
  const rejected = new Map<string, AgentJournalSubmission>()
  for (const submission of submissions) {
    yield

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
  return finishAgentSessionSteps(latestStructuredAgentSessionPromptSteps(items))
}

export function* latestStructuredAgentSessionPromptSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, string> {
  const body = (yield* latestStructuredAgentSessionUserItemSteps(items))?.body
  return body?.kind === 'message' ? messageProse(body.blocks) : ''
}

export function latestStructuredAgentSessionUserItem(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem | null {
  return finishAgentSessionSteps(latestStructuredAgentSessionUserItemSteps(items))
}

export function* latestStructuredAgentSessionUserItemSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, AgentJournalRenderItem | null> {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    yield

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
  return finishAgentSessionSteps(latestStructuredAgentSessionAssistantMessageSteps(items))
}

export function* latestStructuredAgentSessionAssistantMessageSteps(
  items: readonly AgentJournalRenderItem[]
): Generator<void, string> {
  const commandTurns = yield* structuredAgentSessionCommandTurnItemIdsSteps(items)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    yield

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
