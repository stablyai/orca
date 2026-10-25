import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'

export function getEffectiveLayoutForWorktree(
  worktreeId: string,
  layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>,
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string | undefined>
): TabGroupLayoutNode | undefined {
  const layout = layoutByWorktree[worktreeId]
  if (layout) {
    return layout
  }
  const groups = groupsByWorktree[worktreeId] ?? []
  const fallbackGroupId = activeGroupIdByWorktree[worktreeId] ?? groups[0]?.id ?? null
  if (!fallbackGroupId) {
    return undefined
  }
  return { type: 'leaf', groupId: fallbackGroupId } as const
}

/** The container owns every mounted worktree’s panes; gating on the active layout alone destroys background PaneManagers, buffers and PTYs during switches. */
export function anyMountedWorktreeHasLayout(
  allWorktreeIds: string[],
  mountedWorktreeIds: ReadonlySet<string>,
  layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>,
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string | undefined>
): boolean {
  return allWorktreeIds.some(
    (id) =>
      mountedWorktreeIds.has(id) &&
      getEffectiveLayoutForWorktree(id, layoutByWorktree, groupsByWorktree, activeGroupIdByWorktree)
  )
}
