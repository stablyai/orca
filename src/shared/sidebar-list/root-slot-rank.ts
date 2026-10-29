/** Rank used to interleave root groups with ungrouped projects. Explicit
 *  projectGroupOrder shares the axis with group tabOrder; unset sinks after
 *  every group so legacy sidebars stay group-first. */
export function getSidebarRootSlotRank(args: {
  kind: 'project-group' | 'repo'
  tabOrder?: number
  projectGroupOrder?: number | null
  maxRootGroupTabOrder: number
  ungroupedFallbackIndex: number
}): number {
  if (args.kind === 'project-group') {
    return args.tabOrder ?? 0
  }
  const order = args.projectGroupOrder
  if (typeof order === 'number' && Number.isFinite(order)) {
    return order
  }
  const groupFloor = Number.isFinite(args.maxRootGroupTabOrder) ? args.maxRootGroupTabOrder : -1
  return groupFloor + 1 + args.ungroupedFallbackIndex
}
