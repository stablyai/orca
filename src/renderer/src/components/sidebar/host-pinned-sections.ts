import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'

export function getHostPinnedGroupKey(hostId: ExecutionHostId): string {
  return hostId === 'local' ? PINNED_GROUP_KEY : `${PINNED_GROUP_KEY}:host:${hostId}`
}

export function scopePinnedSectionCollapse(args: {
  rows: readonly HostSectionRow[]
  collapsedGroups: ReadonlySet<string>
  defaultHostId: ExecutionHostId
}): HostSectionRow[] {
  return args.rows.flatMap((row): HostSectionRow[] => {
    if (row.type === 'header' && row.key === PINNED_GROUP_KEY) {
      const hostId =
        row.hostId ??
        (row.hostWorktreeCounts?.size === 1
          ? row.hostWorktreeCounts.keys().next().value
          : undefined)
      return [{ ...row, collapseKey: hostId ? getHostPinnedGroupKey(hostId) : row.key }]
    }
    if (row.type === 'item' && row.sectionKey === PINNED_GROUP_KEY) {
      const hostId = getWorktreeExecutionHostId(row.worktree, row.repo, args.defaultHostId)
      if (args.collapsedGroups.has(getHostPinnedGroupKey(hostId))) {
        return []
      }
    }
    return [row]
  })
}
