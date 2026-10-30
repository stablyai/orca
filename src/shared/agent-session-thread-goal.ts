// Derive the current goal solely from the latest journal transition.

import { isRootAgentJournalItem } from './agent-session-journal-producer'
import { isAgentSessionContextClear } from './agent-session-context-clear'
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

/** Recognize legacy goal transitions by provider frame before typed snapshots existed. */
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
  return (
    isAgentSessionContextClear(item.body) ||
    (isRootAgentJournalItem(item) && isAgentJournalThreadGoalRow(item.body))
  )
}

/** For ordered snapshots, scan backwards: undefined means no transition, null means cleared/unreadable. Revisions retain sequence, so the last goal row wins. */
export function currentAgentSessionThreadGoal(
  items: readonly GoalCandidate[],
  minimumSequence = 0
): AgentJournalThreadGoal | null | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && item.sequence > minimumSequence && isGoalTransition(item)) {
      return goalFromRow(item.body)
    }
  }
  return undefined
}

/** The same answer and its source for items a caller holds unordered, such as the host's map. */
export function currentAgentSessionThreadGoalSourceBySequence<T extends GoalCandidate>(
  items: Iterable<T>
): { item: T; goal: AgentJournalThreadGoal | null } | undefined {
  let latest: T | null = null
  for (const item of items) {
    if (isGoalTransition(item) && (latest === null || item.sequence > latest.sequence)) {
      latest = item
    }
  }
  return latest === null ? undefined : { item: latest, goal: goalFromRow(latest.body) }
}

/** Goal statuses that still describe work in progress, so readers keep them in view. */
export function isAgentSessionThreadGoalOpen(goal: AgentJournalThreadGoal | null): boolean {
  return goal !== null && goal.status !== 'complete'
}

/** Paused/stalled/usage-limited goals can resume; completed or token-budget-spent goals can only clear or be replaced. */
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

/** Accrue beyond exact provider time only during an active running turn, starting at the later of updatedAt and turn start. */
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
