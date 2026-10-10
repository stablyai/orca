import type { AppState } from '@/store/types'
import type { AgentAttentionRemainder } from '@/attention/agent-attention-contract'
import {
  mergeAgentAttentionRemainders,
  shouldClearWorkspaceAttention
} from '@/attention/agent-attention-acknowledgement'
import { isStructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'

export function collectTerminalAttentionRemainder(
  state: AppState,
  workspaceId: string
): AgentAttentionRemainder {
  const tabIds = new Set((state.tabsByWorktree[workspaceId] ?? []).map((tab) => tab.id))
  if (tabIds.size === 0) {
    return { hasSurfaces: false, unreadSubjectKeys: [], unreadGroupIds: [] }
  }
  const unreadSubjectKeys: string[] = []
  const unreadPaneKeys = new Set([
    ...Object.keys(state.unreadTerminalPanes),
    ...Object.keys(state.unreadAgentCompletionPanes)
  ])
  for (const paneKey of unreadPaneKeys) {
    const parsed = parsePaneKey(paneKey)
    if (parsed && tabIds.has(parsed.tabId)) {
      unreadSubjectKeys.push(paneKey)
    }
  }
  const unreadGroupIds = Object.keys(state.unreadTerminalTabs).filter((tabId) => tabIds.has(tabId))
  return { hasSurfaces: true, unreadSubjectKeys, unreadGroupIds }
}

export function collectStructuredAttentionRemainder(
  state: AppState,
  workspaceId: string
): AgentAttentionRemainder {
  const tabs = (state.unifiedTabsByWorktree[workspaceId] ?? []).filter(isStructuredTab)
  if (tabs.length === 0) {
    return { hasSurfaces: false, unreadSubjectKeys: [], unreadGroupIds: [] }
  }
  const unreadSubjectKeys: string[] = []
  const unreadGroupIds: string[] = []
  // Closed tabs and superseded sessions cannot hold workspace attention.
  for (const tab of tabs) {
    const subjectKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    if (state.unreadAgentCompletionPanes[subjectKey]) {
      unreadSubjectKeys.push(subjectKey)
    }
    if (state.unreadTerminalTabs[tab.id]) {
      unreadGroupIds.push(tab.id)
    }
  }
  return { hasSurfaces: true, unreadSubjectKeys, unreadGroupIds }
}

// A workspace can hold terminal and structured attention at the same time.
export function collectWorkspaceAttentionRemainder(
  state: AppState,
  workspaceId: string
): AgentAttentionRemainder {
  return mergeAgentAttentionRemainders([
    collectTerminalAttentionRemainder(state, workspaceId),
    collectStructuredAttentionRemainder(state, workspaceId)
  ])
}

export function canClearWorkspaceUnread(state: AppState, workspaceId: string): boolean {
  return shouldClearWorkspaceAttention(collectWorkspaceAttentionRemainder(state, workspaceId), {
    viewedGroupId: null,
    clearedSubjectKeys: new Set()
  })
}
