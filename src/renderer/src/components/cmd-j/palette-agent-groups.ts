import type { AgentDotState } from '@/components/AgentStateDot'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { activityThreadStatusId } from '../activity/activity-thread-presentation'
import type { AgentPaneThread } from '../activity/activity-thread-types'

/** Empty-query Cmd+J agent groups, in display order. */
export type PaletteAgentGroupKey = 'needs-you' | 'unread-results' | 'working'

export type PaletteAgentGroup = {
  key: PaletteAgentGroupKey
  /** Rows shown, already in display order and within the shared budget. */
  threads: AgentPaneThread[]
  /** Every member, including rows the budget left out. */
  total: number
}

const GROUP_ORDER: readonly PaletteAgentGroupKey[] = ['needs-you', 'unread-results', 'working']
const GROUP_ROW_LIMIT: Record<PaletteAgentGroupKey, number> = {
  'needs-you': 3,
  'unread-results': 2,
  working: 2
}
export const PALETTE_AGENT_ROW_BUDGET = 4

const NEEDS_YOU_RANK: Partial<Record<AgentDotState, number>> = {
  waiting: 0,
  blocked: 1,
  permission: 2
}
const UNREAD_RESULT_RANK: Partial<Record<AgentDotState, number>> = {
  failed: 0,
  unconfirmed: 1,
  done: 2
}

type ClassifyContext = {
  now: number
  /** Native chats publish no heartbeat, so their status is never stale. */
  isNativeChat: (thread: AgentPaneThread) => boolean
}

function isFreshThread(thread: AgentPaneThread, context: ClassifyContext): boolean {
  return (
    context.isNativeChat(thread) ||
    (thread.paneEntry !== undefined &&
      isExplicitAgentStatusFresh(thread.paneEntry, context.now, AGENT_STATUS_STALE_AFTER_MS))
  )
}

/** The first group a thread qualifies for, or null. Missing or unconfirmed data never promotes a row. */
export function classifyPaletteAgentThread(
  thread: AgentPaneThread,
  context: ClassifyContext
): PaletteAgentGroupKey | null {
  const status = activityThreadStatusId(thread)
  if (
    NEEDS_YOU_RANK[status] !== undefined &&
    thread.paneEntry !== undefined &&
    thread.paneEntry.restoredUnconfirmed !== true &&
    !thread.migrationUnsupportedPtyId &&
    // Why: a stale wait can't be told from an agent that exited mid-ask; show it until seen once.
    (isFreshThread(thread, context) || thread.unread)
  ) {
    return 'needs-you'
  }
  if (thread.unread && UNREAD_RESULT_RANK[status] !== undefined) {
    return 'unread-results'
  }
  if ((status === 'working' || status === 'monitoring') && thread.currentAgentState !== null) {
    return 'working'
  }
  return null
}

function byRecencyThenKey(a: AgentPaneThread, b: AgentPaneThread): number {
  return b.latestTimestamp - a.latestTimestamp || a.paneKey.localeCompare(b.paneKey)
}

function compareWithin(
  key: PaletteAgentGroupKey,
  context: ClassifyContext
): (a: AgentPaneThread, b: AgentPaneThread) => number {
  if (key === 'needs-you') {
    return (a, b) =>
      Number(isFreshThread(b, context)) - Number(isFreshThread(a, context)) ||
      Number(b.unread) - Number(a.unread) ||
      (NEEDS_YOU_RANK[activityThreadStatusId(a)] ?? 0) -
        (NEEDS_YOU_RANK[activityThreadStatusId(b)] ?? 0) ||
      byRecencyThenKey(a, b)
  }
  if (key === 'unread-results') {
    return (a, b) =>
      (UNREAD_RESULT_RANK[activityThreadStatusId(a)] ?? 0) -
        (UNREAD_RESULT_RANK[activityThreadStatusId(b)] ?? 0) || byRecencyThenKey(a, b)
  }
  return byRecencyThenKey
}

/** Groups candidates under one shared row budget; groups with no members are omitted. */
export function buildPaletteAgentGroups(
  candidates: readonly AgentPaneThread[],
  context: ClassifyContext,
  budget = PALETTE_AGENT_ROW_BUDGET
): PaletteAgentGroup[] {
  const members = new Map<PaletteAgentGroupKey, AgentPaneThread[]>()
  for (const thread of candidates) {
    const key = classifyPaletteAgentThread(thread, context)
    if (key) {
      const bucket = members.get(key)
      if (bucket) {
        bucket.push(thread)
      } else {
        members.set(key, [thread])
      }
    }
  }
  let remaining = budget
  const groups: PaletteAgentGroup[] = []
  for (const key of GROUP_ORDER) {
    const threads = members.get(key)
    if (!threads?.length) {
      continue
    }
    const sorted = threads.sort(compareWithin(key, context))
    const shown = sorted.slice(0, Math.min(GROUP_ROW_LIMIT[key], remaining))
    remaining -= shown.length
    groups.push({ key, threads: shown, total: sorted.length })
  }
  return groups
}
