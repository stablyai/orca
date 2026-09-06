import { agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import {
  agentMeta,
  agentSummary,
  agentTitle,
  threadAgentState,
  threadAgentStateLabel
} from './activity-thread-presentation'
import type {
  ActivityGroupBy,
  ActivityStatusGroupId,
  ActivityThreadGroup,
  AgentPaneThread
} from './activity-thread-types'

// Attention-needing groups first (interrupted included: it's stopped and awaiting the user) so they're never buried under Working/Done.
const ACTIVITY_STATUS_GROUP_ORDER: ActivityStatusGroupId[] = [
  'waiting',
  'blocked',
  'interrupted',
  'working',
  'monitoring',
  'done'
]

export function getActivityThreadGroup(
  thread: AgentPaneThread,
  groupBy: ActivityGroupBy
): { key: string; label: string } {
  if (groupBy === 'none') {
    return { key: 'all', label: '' }
  }
  if (groupBy === 'status') {
    const state = threadAgentState(thread)
    if (!thread.currentAgentState && state === 'done' && thread.latestEvent?.entry.interrupted) {
      return { key: 'done:interrupted', label: threadAgentStateLabel(thread) }
    }
    return { key: state, label: threadAgentStateLabel(thread) }
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
      groups.push({ key: group.key, label: group.label, threads: [thread] })
      groupIndexByKey.set(group.key, groups.length - 1)
      continue
    }
    groups[existingIndex].threads.push(thread)
  }
  return groups
}

export function threadStatusGroupId(thread: AgentPaneThread): ActivityStatusGroupId {
  const state = threadAgentState(thread)
  if (!thread.currentAgentState && state === 'done' && thread.latestEvent?.entry.interrupted) {
    return 'interrupted'
  }
  return state === 'working' || state === 'monitoring' || state === 'blocked' || state === 'waiting'
    ? state
    : 'done'
}

function threadStatusGroupState(id: ActivityStatusGroupId): AgentDotState {
  return id === 'interrupted' ? 'done' : id
}

function threadStatusGroupLabel(id: ActivityStatusGroupId): string {
  if (id === 'interrupted') {
    return 'Interrupted'
  }
  return agentStateLabel(threadStatusGroupState(id))
}

export function groupActivityThreadsByStatus(threads: AgentPaneThread[]): ActivityThreadGroup[] {
  const groups = new Map<ActivityStatusGroupId, AgentPaneThread[]>()
  for (const thread of threads) {
    const groupId = threadStatusGroupId(thread)
    groups.set(groupId, [...(groups.get(groupId) ?? []), thread])
  }
  return ACTIVITY_STATUS_GROUP_ORDER.flatMap((id) => {
    const groupThreads = groups.get(id) ?? []
    if (groupThreads.length === 0) {
      return []
    }
    return [
      {
        key: id,
        id,
        label: threadStatusGroupLabel(id),
        state: threadStatusGroupState(id),
        threads: groupThreads
      }
    ]
  })
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
