import type { AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  activityThreadStatusId,
  agentMeta,
  agentSummary,
  agentTitle,
  threadAgentState,
  threadAgentStateLabel,
  type ActivityThreadStatusId
} from './activity-thread-presentation'
import type { ActivityGroupBy, ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'

// Attention-first. Exhaustive Record so an unranked dot state is a type error; ranks are
// unique so header order never falls back to thread recency.
const ACTIVITY_STATUS_GROUP_RANK: Record<ActivityThreadStatusId, number> = {
  waiting: 0,
  blocked: 1,
  permission: 2,
  interrupted: 3,
  working: 4,
  monitoring: 5,
  unverifiable: 6,
  failed: 7,
  done: 8,
  idle: 9
}

function activityStatusRank(thread: AgentPaneThread): number {
  return ACTIVITY_STATUS_GROUP_RANK[activityThreadStatusId(thread)]
}

export function getActivityThreadGroup(
  thread: AgentPaneThread,
  groupBy: ActivityGroupBy
): { key: string; label: string; state?: AgentDotState } {
  if (groupBy === 'none') {
    return { key: 'all', label: '' }
  }
  if (groupBy === 'status') {
    // Header dot mirrors the row dot, so the two can never disagree.
    return {
      key: activityThreadStatusId(thread),
      label: threadAgentStateLabel(thread),
      state: threadAgentState(thread)
    }
  }
  if (groupBy === 'project') {
    return thread.repo
      ? { key: `project:${thread.repo.id}`, label: thread.repo.displayName }
      : {
          key: 'project:unknown',
          label: translate(
            'auto.components.activity.ActivityPrototypePage.5651b216c6',
            'Unknown project'
          )
        }
  }
  if (groupBy === 'worktree') {
    return { key: `worktree:${thread.worktree.id}`, label: thread.worktree.displayName }
  }
  return { key: `agent:${thread.agentType}`, label: formatAgentTypeLabel(thread.agentType) }
}

export function buildActivityThreadGroups(
  threads: AgentPaneThread[],
  groupBy: ActivityGroupBy
): ActivityThreadGroup[] {
  if (groupBy === 'none') {
    return threads.length > 0 ? [{ key: 'all', label: '', threads }] : []
  }
  const groups: ActivityThreadGroup[] = []
  const groupIndexByKey = new Map<string, number>()
  for (const thread of threads) {
    const group = getActivityThreadGroup(thread, groupBy)
    const existingIndex = groupIndexByKey.get(group.key)
    if (existingIndex === undefined) {
      groups.push({ ...group, threads: [thread] })
      groupIndexByKey.set(group.key, groups.length - 1)
      continue
    }
    groups[existingIndex].threads.push(thread)
  }
  if (groupBy !== 'status') {
    return groups
  }
  return groups.sort((a, b) => activityStatusRank(a.threads[0]) - activityStatusRank(b.threads[0]))
}

function buildThreadSearchText(thread: AgentPaneThread): string {
  const latest = thread.latestEvent
  const stateLabel = threadAgentStateLabel(thread)
  const currentPrompt = thread.currentAgentEntry
    ? getAgentRowPrimaryText(thread.currentAgentEntry)
    : ''
  const rawCurrentPrompt = thread.currentAgentEntry?.prompt.trim() ?? ''
  const currentSummary = thread.currentAgentEntry?.lastAssistantMessage?.trim() ?? ''
  const latestEventText = latest
    ? `${agentTitle(latest)} ${agentSummary(latest)} ${agentMeta(latest)}`
    : ''
  return `${thread.paneTitle} ${getActivityThreadWorkspaceTitle(thread.worktree)} ${thread.worktree.branch ?? ''} ${thread.repo?.displayName ?? ''} ${formatAgentTypeLabel(thread.agentType)} ${stateLabel} ${currentPrompt} ${rawCurrentPrompt} ${currentSummary} ${thread.responsePreview} ${latestEventText}`.toLowerCase()
}

// Why: thread objects are rebuilt only when the underlying store data changes, so their
// identity is a correct cache key; without this every keystroke re-lowercases a large
// string per thread. WeakMap so dropped threads release their text.
const threadSearchTextCache = new WeakMap<AgentPaneThread, string>()
let threadSearchTextComputeCount = 0

/** Test hook: how many times search text was actually (re)built. */
export function getThreadSearchTextComputeCount(): number {
  return threadSearchTextComputeCount
}

function threadSearchText(thread: AgentPaneThread): string {
  const cached = threadSearchTextCache.get(thread)
  if (cached !== undefined) {
    return cached
  }
  threadSearchTextComputeCount += 1
  const text = buildThreadSearchText(thread)
  threadSearchTextCache.set(thread, text)
  return text
}

export const ACTIVITY_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isActivitySearchQueryTooLarge(
  query: string,
  maxBytes = ACTIVITY_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function activityThreadMatchesSearchQuery({
  thread,
  searchQuery
}: {
  thread: AgentPaneThread
  searchQuery: string
}): boolean {
  if (isActivitySearchQueryTooLarge(searchQuery)) {
    return false
  }
  const trimmedQuery = searchQuery.trim()
  if (!trimmedQuery) {
    return true
  }
  return threadSearchText(thread).includes(trimmedQuery.toLowerCase())
}
