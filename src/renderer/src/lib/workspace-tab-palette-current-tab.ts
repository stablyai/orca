import type { Tab } from '../../../shared/tab-types'
import type {
  BuildSearchableWorkspaceTabsOptions,
  WorkspaceTabContentType
} from './workspace-tab-palette-search'

export function getActiveUnifiedTabId({
  worktreeId,
  isCurrentWorktree,
  activeTabType,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  'activeGroupIdByWorktree' | 'activeTabType' | 'groupsByWorktree'
> & { worktreeId: string; isCurrentWorktree: boolean }): string | null {
  if (!isCurrentWorktree) {
    return null
  }
  const activeGroupId = activeGroupIdByWorktree[worktreeId]
  const activeGroup = activeGroupId
    ? (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  const activeUnifiedTabId = activeGroup?.activeTabId ?? null
  return activeTabType === 'terminal' || activeTabType === 'editor' || activeTabType === 'database'
    ? activeUnifiedTabId
    : null
}

export function isCurrentWorkspaceTab({
  tab,
  isCurrentWorktree,
  activeTabType,
  activeTabId,
  activeTabIdByWorktree,
  activeFileId,
  activeFileIdByWorktree,
  activeTabTypeByWorktree,
  activeUnifiedTabId
}: Pick<
  BuildSearchableWorkspaceTabsOptions,
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
> & {
  tab: Tab & { contentType: WorkspaceTabContentType }
  isCurrentWorktree: boolean
  activeUnifiedTabId: string | null
}): boolean {
  if (!isCurrentWorktree) {
    return false
  }
  if (activeUnifiedTabId) {
    return activeUnifiedTabId === tab.id
  }
  const visibleType = tab.contentType === 'terminal' ? 'terminal' : 'editor'
  const storedType = activeTabTypeByWorktree[tab.worktreeId] ?? activeTabType
  if (storedType !== visibleType) {
    return false
  }
  return visibleType === 'terminal'
    ? (activeTabIdByWorktree[tab.worktreeId] ?? activeTabId) === tab.entityId
    : (activeFileIdByWorktree[tab.worktreeId] ?? activeFileId) === tab.entityId
}
