// The session's current thread goal, derived from the journal rather than stored
// beside it. The latest goal transition in journal order is the whole answer.

import { isRootAgentJournalItem } from './agent-session-journal-producer'
import {
  AGENT_JOURNAL_THREAD_GOAL_STATUSES,
  type AgentJournalItemBody,
  type AgentJournalRenderItem,
  type AgentJournalThreadGoal,
  type AgentJournalThreadGoalStatus
} from './agent-session-journal-types'

const GOAL_FRAME_KINDS = new Set([
  'notification:thread/goal/updated',
  'notification:thread/goal/cleared'
])

type GoalCandidate = Pick<AgentJournalRenderItem, 'sequence' | 'body' | 'agentId'>

export function isAgentJournalThreadGoalStatus(
  value: string
): value is AgentJournalThreadGoalStatus {
  return AGENT_JOURNAL_THREAD_GOAL_STATUSES.some((status) => status === value)
}

/** Whether a provider frame reports a goal transition. */
export function isAgentSessionThreadGoalFrame(
  frame: { provider: string; kind: string } | undefined
): boolean {
  return frame?.provider === 'codex' && GOAL_FRAME_KINDS.has(frame.kind)
}

/** Whether a row records a goal transition. Rows written before the typed
 *  snapshot existed are still recognized by their frame. */
export function isAgentJournalThreadGoalRow(body: AgentJournalItemBody): boolean {
  return (
    body.kind === 'status' &&
    (body.threadGoal !== undefined || isAgentSessionThreadGoalFrame(body.providerFrame))
  )
}

function goalFromRow(body: AgentJournalItemBody): AgentJournalThreadGoal | null {
  if (body.kind !== 'status' || body.threadGoal?.state !== 'set') {
    // Cleared, an unknown state, or a legacy row whose payload may be truncated.
    return null
  }
  return isAgentJournalThreadGoalStatus(body.threadGoal.goal.status) ? body.threadGoal.goal : null
}

function isGoalTransition(item: GoalCandidate): boolean {
  return isRootAgentJournalItem(item) && isAgentJournalThreadGoalRow(item.body)
}

/**
 * The current goal as far as these rows can tell: `undefined` when none of them
 * records a goal transition, otherwise the latest one's goal, or null when it
 * cleared the goal or cannot be read. Scans backwards because every caller passes
 * a rendered snapshot, which is already in sequence order; a revision keeps its
 * row's sequence, so the last goal row is the answer.
 */
export function currentAgentSessionThreadGoal(
  items: readonly GoalCandidate[]
): AgentJournalThreadGoal | null | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && isGoalTransition(item)) {
      return goalFromRow(item.body)
    }
  }
  return undefined
}

/** The same answer for items a caller holds unordered, such as the host's own map. */
export function currentAgentSessionThreadGoalBySequence(
  items: Iterable<GoalCandidate>
): AgentJournalThreadGoal | null | undefined {
  let latest: GoalCandidate | null = null
  for (const item of items) {
    if (isGoalTransition(item) && (latest === null || item.sequence > latest.sequence)) {
      latest = item
    }
  }
  return latest === null ? undefined : goalFromRow(latest.body)
}

/** Goal statuses that still describe work in progress, so readers keep them in view. */
export function isAgentSessionThreadGoalOpen(goal: AgentJournalThreadGoal | null): boolean {
  return goal !== null && goal.status !== 'complete'
}

/** The status change a goal in this status accepts, or null when it accepts none:
 *  a stalled or usage-limited goal resumes the same way a paused one does, while
 *  a spent token budget and a completed goal can only be cleared or replaced. */
export function agentSessionThreadGoalStatusChange(
  status: AgentJournalThreadGoalStatus
): 'active' | 'paused' | null {
  switch (status) {
    case 'active':
      return 'paused'
    case 'paused':
    case 'blocked':
    case 'usageLimited':
      return 'active'
    case 'budgetLimited':
    case 'complete':
      return null
  }
}

/**
 * Seconds of goal work. The provider's `timeUsedSeconds` is exact as of `updatedAt`;
 * only an active goal with a turn running accrues more, counted from whichever of
 * that report and the turn's start is later.
 */
export function agentSessionThreadGoalElapsedSeconds(
  goal: AgentJournalThreadGoal,
  now: number,
  runningTurn: { startedAt: number | null } | null
): number {
  const reported = Math.max(0, goal.timeUsedSeconds)
  if (goal.status !== 'active' || runningTurn === null) {
    return reported
  }
  const since = Math.max(goal.updatedAt, runningTurn.startedAt ?? goal.updatedAt)
  return reported + Math.max(0, Math.floor((now - since) / 1000))
}
