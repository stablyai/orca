import type { TabGroup, TuiAgent } from '../../../../shared/types'
import type { TabSplitDirection } from '../../store/slices/tabs'

export type TabDropZone = 'center' | TabSplitDirection

export type TabDragItemData = {
  kind: 'tab'
  worktreeId: string
  groupId: string
  unifiedTabId: string
  visibleTabId: string
  tabType: 'terminal' | 'editor' | 'browser' | 'simulator'
  label: string
  iconPath?: string
  color?: string | null
  agent?: TuiAgent | null
}

export type TabPaneDropData = {
  kind: 'pane-body'
  worktreeId: string
  groupId: string
}

export function canDropTabIntoPaneBody({
  activeDrag,
  groupsByWorktree,
  overGroupId,
  worktreeId
}: {
  activeDrag: TabDragItemData | null
  groupsByWorktree: Record<string, TabGroup[]>
  overGroupId: string
  worktreeId: string
}): boolean {
  if (!activeDrag || activeDrag.worktreeId !== worktreeId) {
    return false
  }

  const overGroup = (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === overGroupId)
  if (!overGroup) {
    return false
  }

  return activeDrag.groupId !== overGroupId || overGroup.tabOrder.length > 1
}

export function isTabDragData(value: unknown): value is TabDragItemData {
  return Boolean(value) && typeof value === 'object' && (value as TabDragItemData).kind === 'tab'
}

export function isPaneDropData(value: unknown): value is TabPaneDropData {
  return (
    Boolean(value) && typeof value === 'object' && (value as TabPaneDropData).kind === 'pane-body'
  )
}
