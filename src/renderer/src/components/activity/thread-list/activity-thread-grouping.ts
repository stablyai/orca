import type { AgentListStatus as AgentDotState } from '../../../../../shared/agent-status/presentation/agent-list-status'
import { translate } from '@/i18n/i18n'
import { getTranslationResourceVersion } from '@/i18n/translation-resource-version'
import type { Translate } from '@/i18n/use-translate'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { getAgentRowPrimaryText } from '../../../../../shared/agent-status/presentation/agent-row-primary-text'
import { getActivityThreadWorkspaceTitle } from '@/lib/workspace/activity/activity-thread-display'
import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard/clipboard-text'
import {
  activityThreadStatusId,
  agentMeta,
  agentSummary,
  agentTitle,
  threadAgentStateLabel
} from '../threads/activity-thread-presentation'
import { AGENT_LIST_STATUS_RANK } from '../../../../../shared/agent-status/presentation/agent-list-status'
import type { ActivityGroupBy } from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'
import type { ActivityThreadGroup, AgentPaneThread } from '../threads/activity-thread-types'

function activityStatusRank(thread: AgentPaneThread): number {
  return AGENT_LIST_STATUS_RANK[activityThreadStatusId(thread)]
}

export function getActivityThreadGroup(
  thread: AgentPaneThread,
  groupBy: ActivityGroupBy,
  t: Translate = translate
): { key: string; label: string; state?: AgentDotState } {
  if (groupBy === 'none') {
    return { key: 'all', label: '' }
  }
  if (groupBy === 'status') {
    // The key is the glyph every row in the group draws, so it heads the group too.
    const status = activityThreadStatusId(thread)
    return { key: status, label: threadAgentStateLabel(thread, t), state: status }
  }
  if (groupBy === 'project') {
    return thread.repo
      ? { key: `project:${thread.repo.id}`, label: thread.repo.displayName }
      : {
          key: 'project:unknown',
          label: t('auto.components.activity.ActivityPrototypePage.5651b216c6', 'Unknown project')
        }
  }
  if (groupBy === 'worktree') {
    return { key: `worktree:${thread.worktree.id}`, label: thread.worktree.displayName }
  }
  return { key: `agent:${thread.agentType}`, label: formatAgentTypeLabel(thread.agentType, t) }
}

export function buildActivityThreadGroups(
  threads: AgentPaneThread[],
  groupBy: ActivityGroupBy,
  t?: Translate
): ActivityThreadGroup[] {
  if (groupBy === 'none') {
    return threads.length > 0 ? [{ key: 'all', label: '', threads }] : []
  }
  const groups: ActivityThreadGroup[] = []
  const groupIndexByKey = new Map<string, number>()
  for (const thread of threads) {
    const group = getActivityThreadGroup(thread, groupBy, t)
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
  return `${thread.paneTitle} ${getActivityThreadWorkspaceTitle(thread.worktree)} ${thread.worktree.branch ?? ''} ${thread.repo?.displayName ?? ''} ${thread.agentType} ${formatAgentTypeLabel(thread.agentType, translate)} ${stateLabel} ${currentPrompt} ${rawCurrentPrompt} ${currentSummary} ${thread.responsePreview} ${latestEventText}`.toLowerCase()
}

// Thread identity changes with its data, so cache lowercase search text across keystrokes; WeakMap releases dropped threads.
// Shared threads outlive a language switch, so the text is also keyed by the translation version.
const threadSearchTextCache = new WeakMap<AgentPaneThread, { version: number; text: string }>()
function threadSearchText(thread: AgentPaneThread): string {
  const version = getTranslationResourceVersion()
  const cached = threadSearchTextCache.get(thread)
  if (cached?.version === version) {
    return cached.text
  }
  const text = buildThreadSearchText(thread)
  threadSearchTextCache.set(thread, { version, text })
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
