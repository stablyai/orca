import type { PendingSidebarRevealArgs } from './pending-reveal-inputs'
import { getSidebarRowRevealAncestorKeys } from './reveal-ancestors'

export function expandSidebarRowRevealAncestors(
  current: Pick<
    PendingSidebarRevealArgs,
    'repoMap' | 'projectGroups' | 'projectGrouping' | 'collapsedGroups' | 'toggleGroup'
  >,
  rowKey: string
): boolean {
  let toggledAncestor = false
  for (const groupKey of getSidebarRowRevealAncestorKeys({
    rowKey,
    repoMap: current.repoMap,
    projectGroups: current.projectGroups,
    projectGrouping: current.projectGrouping
  })) {
    if (current.collapsedGroups.has(groupKey)) {
      current.toggleGroup(groupKey)
      toggledAncestor = true
    }
  }
  return toggledAncestor
}
