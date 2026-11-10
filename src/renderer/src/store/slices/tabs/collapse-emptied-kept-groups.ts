import type { AppState } from '../../types'
import type { RecordDraft } from '../../keyed-record-transitions'
import { collapseWorktreeGroupLayout } from '../../../../../shared/workspace-layout/tab-group-layout-tree'

export type GroupLayoutDrafts = {
  groups: RecordDraft<AppState['groupsByWorktree'][string]>
  layout: RecordDraft<AppState['layoutByWorktree'][string]>
  activeGroups: RecordDraft<AppState['activeGroupIdByWorktree'][string]>
}

/** Collapse kept splits emptied by purge, giving their space/selection to the surviving twin’s group. */
export function collapseEmptiedKeptGroups(
  groupsBefore: AppState['groupsByWorktree'],
  drafts: GroupLayoutDrafts,
  worktreeIds: ReadonlySet<string>
): void {
  for (const worktreeId of worktreeIds) {
    const before = groupsBefore[worktreeId] ?? []
    const stored = drafts.groups.get(worktreeId)
    let groups = stored ?? []
    const emptied = groups.filter(
      (group) =>
        group.tabOrder.length === 0 &&
        (before.find((prior) => prior.id === group.id)?.tabOrder.length ?? 0) > 0
    )
    for (const group of emptied) {
      const layout = drafts.layout.get(worktreeId)
      if (groups.length <= 1 || !layout) {
        break
      }
      groups = groups.filter((candidate) => candidate.id !== group.id)
      const activeGroupId = drafts.activeGroups.get(worktreeId)
      const collapsed = collapseWorktreeGroupLayout(
        layout,
        activeGroupId,
        group.id,
        groups[0]?.id ?? null
      )
      if (collapsed.layout) {
        drafts.layout.set(worktreeId, collapsed.layout)
      } else {
        drafts.layout.delete(worktreeId)
      }
      // Why: only the collapsed group's own focus moves; an untouched active group keeps it.
      if (
        (activeGroupId === undefined || activeGroupId === group.id) &&
        collapsed.activeGroupId !== undefined
      ) {
        drafts.activeGroups.set(worktreeId, collapsed.activeGroupId)
      }
    }
    // An absent entry is written even when empty, as the record spread this replaces did.
    if (stored === undefined || groups !== stored) {
      drafts.groups.set(worktreeId, groups)
    }
  }
}
