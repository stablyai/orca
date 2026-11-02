import type { AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { getAgentRowPrimaryText } from '../../../../shared/agent-row-primary-text'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  activityThreadStatusId,
  agentMeta,
  agentSummary,
  agentTitle,
  threadAgentStateLabel,
  type ActivityThreadStatusId
} from './activity-thread-presentation'
import type { ActivityGroupBy, ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'

// Use exhaustive, unique attention ranks so new states fail typecheck and recency cannot reorder headers.
const ACTIVITY_STATUS_GROUP_RANK: Record<ActivityThreadStatusId, number> = {
  waiting: 0,
  blocked: 1,
  permission: 2,
  failed: 3,
  unconfirmed: 4,
  working: 5,
  monitoring: 6,
  // A user's Stop is not news, so it follows live work, but it is not a finish either.
  interrupted: 7,
  unverifiable: 8,
  done: 9,
  idle: 10
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
    // The key is the glyph every row in the group draws, so it heads the group too.
    const status = activityThreadStatusId(thread)
    return { key: status, label: threadAgentStateLabel(thread), state: status }
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

// Thread identity changes with its data, so cache lowercase search text across keystrokes; WeakMap releases dropped threads.
const threadSearchTextCache = new WeakMap<AgentPaneThread, string>()
function threadSearchText(thread: AgentPaneThread): string {
  const cached = threadSearchTextCache.get(thread)
  if (cached !== undefined) {
    return cached
  }
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

export function createActivityThreadSearchMatcher(
  searchQuery: string
): (thread: AgentPaneThread) => boolean {
  if (isActivitySearchQueryTooLarge(searchQuery)) {
    return () => false
  }
  const trimmedQuery = searchQuery.trim()
  if (!trimmedQuery) {
    return () => true
  }
  const normalizedQuery = trimmedQuery.toLowerCase()
  return (thread) => threadSearchText(thread).includes(normalizedQuery)
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
