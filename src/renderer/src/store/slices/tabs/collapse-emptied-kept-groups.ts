import type { AppState } from '../../types'
import { collapseGroupLayout } from '../../../../../shared/workspace-layout/tab-group-layout-tree'

/** Collapse kept splits emptied by purge, giving their space/selection to the surviving twin’s group. */
export function collapseEmptiedKeptGroups(
  s: Pick<AppState, 'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'>,
  groupsByWorktree: AppState['groupsByWorktree'],
  worktreeIds: ReadonlySet<string>
): {
  groups: AppState['groupsByWorktree']
  layout: AppState['layoutByWorktree']
  activeGroups: AppState['activeGroupIdByWorktree']
} {
  let groupsOut = groupsByWorktree
  let layoutOut = s.layoutByWorktree
  let activeOut = s.activeGroupIdByWorktree
  for (const worktreeId of worktreeIds) {
    const before = s.groupsByWorktree[worktreeId] ?? []
    let groups = groupsOut[worktreeId] ?? []
    const emptied = groups.filter(
      (group) =>
        group.tabOrder.length === 0 &&
        (before.find((prior) => prior.id === group.id)?.tabOrder.length ?? 0) > 0
    )
    for (const group of emptied) {
      if (groups.length <= 1 || !layoutOut[worktreeId]) {
        break
      }
      groups = groups.filter((candidate) => candidate.id !== group.id)
      const collapsed = collapseGroupLayout(
        layoutOut,
        activeOut,
        worktreeId,
        group.id,
        groups[0]?.id ?? null
      )
      layoutOut = collapsed.layoutByWorktree
      // Why: only the collapsed group's own focus moves; an untouched active group keeps it.
      const activeGroupId = activeOut[worktreeId]
      activeOut =
        activeGroupId === undefined || activeGroupId === group.id
          ? collapsed.activeGroupIdByWorktree
          : { ...collapsed.activeGroupIdByWorktree, [worktreeId]: activeGroupId }
    }
    if (groups !== (groupsOut[worktreeId] ?? [])) {
      groupsOut = { ...groupsOut, [worktreeId]: groups }
    }
  }
  return { groups: groupsOut, layout: layoutOut, activeGroups: activeOut }
}
