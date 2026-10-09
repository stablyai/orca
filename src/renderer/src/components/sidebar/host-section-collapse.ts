import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'

export function isHostLaneSectionKey(key: string): boolean {
  return (
    key === PINNED_GROUP_KEY ||
    key === 'all' ||
    key.startsWith('pr:') ||
    key.startsWith('workspace-status:')
  )
}

export function getHostSectionCollapseKey(key: string, hostId: ExecutionHostId): string {
  return hostId === 'local' || !isHostLaneSectionKey(key) ? key : `${key}:host:${hostId}`
}

export function deferHostSectionCollapse(collapsedGroups: Set<string>): Set<string> {
  if (![...collapsedGroups].some(isHostLaneSectionKey)) {
    return collapsedGroups
  }
  return new Set([...collapsedGroups].filter((key) => !isHostLaneSectionKey(key)))
}

export function scopeHostSectionCollapse(args: {
  rows: readonly HostSectionRow[]
  collapsedGroups: ReadonlySet<string>
}): HostSectionRow[] {
  let sectionCollapsed = false
  return args.rows.flatMap((row): HostSectionRow[] => {
    if (row.type === 'host-header') {
      sectionCollapsed = false
    }
    if (row.type === 'header') {
      sectionCollapsed = false
      if (!isHostLaneSectionKey(row.key)) {
        return [row]
      }
      const hostId =
        row.hostId ??
        (row.hostWorktreeCounts?.size === 1
          ? row.hostWorktreeCounts.keys().next().value
          : undefined)
      const collapseKey = hostId ? getHostSectionCollapseKey(row.key, hostId) : row.key
      sectionCollapsed = args.collapsedGroups.has(collapseKey)
      return [{ ...row, collapseKey }]
    }
    return sectionCollapsed ? [] : [row]
  })
}
