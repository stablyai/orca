import { useAppStore } from '@/store'
import type { WorkspaceTabTopology } from '../../../../shared/workspace-tab-location'
import { describeWorkspaceTabLayout } from '../../../../shared/workspace-tab-location'

export function readWorkspaceTabTopology(workspaceId: string): WorkspaceTabTopology {
  const state = useAppStore.getState()
  return {
    tabs: state.unifiedTabsByWorktree[workspaceId] ?? [],
    groups: state.groupsByWorktree[workspaceId] ?? [],
    layout: state.layoutByWorktree[workspaceId] ?? null,
    activeGroupId: state.activeGroupIdByWorktree[workspaceId] ?? null
  }
}

export function describeTabLocation(unifiedTabId: string, groupId: string) {
  const state = useAppStore.getState()
  const workspaceId = Object.keys(state.unifiedTabsByWorktree).find((id) =>
    state.unifiedTabsByWorktree[id].some(
      (tab) => tab.id === unifiedTabId && tab.groupId === groupId
    )
  )
  if (!workspaceId) {
    throw new Error('tab_not_found')
  }
  const workspace = describeWorkspaceTabLayout(
    workspaceId,
    readWorkspaceTabTopology(workspaceId),
    'open',
    state.activeWorktreeId === workspaceId
  )
  const tab = workspace.tabs.find((candidate) => candidate.tabId === unifiedTabId)
  if (!tab || tab.position === null) {
    throw new Error('tab_position_unavailable')
  }
  const file = state.openFiles.find(
    (candidate) => candidate.worktreeId === workspaceId && candidate.id === tab.contentId
  )
  return { ...workspace, tabs: [{ ...tab, filePath: file?.filePath ?? null }] }
}
