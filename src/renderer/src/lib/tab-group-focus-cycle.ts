import { useAppStore } from '@/store'
import { getEffectiveLayoutForWorktree } from '@/components/terminal/split-group-mount'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'
import type { TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'

/** Layout leaves read first-then-second, which is left-to-right and top-to-bottom on screen. */
export function resolveAdjacentTabGroupId(
  layout: TabGroupLayoutNode | undefined,
  groups: readonly Pick<TabGroup, 'id'>[],
  activeGroupId: string | undefined,
  direction: 1 | -1
): string | null {
  const groupIds = [...collectTabGroupLayoutGroupIds(layout)].filter((groupId) =>
    groups.some((group) => group.id === groupId)
  )
  if (groupIds.length < 2) {
    return null
  }
  const index = activeGroupId ? groupIds.indexOf(activeGroupId) : -1
  if (index === -1) {
    return groupIds[0]
  }
  return groupIds[(index + direction + groupIds.length) % groupIds.length]
}

/** Moves keyboard focus to the neighboring split, keeping each split's active tab. */
export function focusAdjacentTabGroup(worktreeId: string, direction: 1 | -1): boolean {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const layout = getEffectiveLayoutForWorktree(
    worktreeId,
    state.layoutByWorktree,
    state.groupsByWorktree,
    state.activeGroupIdByWorktree
  )
  const targetGroupId = resolveAdjacentTabGroupId(
    layout,
    groups,
    state.activeGroupIdByWorktree[worktreeId],
    direction
  )
  if (!targetGroupId) {
    return false
  }
  state.focusGroup(worktreeId, targetGroupId)
  return true
}
