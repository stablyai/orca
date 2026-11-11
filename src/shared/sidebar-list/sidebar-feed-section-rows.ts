import { deferHostSectionCollapse, scopeHostSectionCollapse } from './host-section-collapse'
import { addHostSectionRows } from './host-section-rows'
import type { SidebarFeedPlan, SidebarFeedView, SidebarFeedRows } from './sidebar-feed-rows'

/** The planned rows under `collapsedGroups`, wrapped in host sections. */
export function renderSidebarFeedRows(
  planned: SidebarFeedPlan,
  view: SidebarFeedView,
  collapsedGroups: ReadonlySet<string>,
  forceCollapseHosts = false
): Pick<SidebarFeedRows, 'rows' | 'sectionRows'> {
  const collapsed = new Set(collapsedGroups)
  const rows = planned.plan.render(
    planned.hostScoped ? deferHostSectionCollapse(collapsed) : collapsed
  )
  const sectioned = addHostSectionRows({
    rows,
    hostOptions: planned.orderedHostOptions,
    workspaceHostScope: view.workspaceHostScope,
    visibleWorkspaceHostIds: view.visibleWorkspaceHostIds,
    defaultHostId: view.defaultHostId,
    localHostLabel: view.localHostLabel,
    collapsedHostKeys: collapsed,
    forceCollapseHosts,
    preferProjectGrouping: true
  })
  const sectionRows = planned.hostScoped
    ? scopeHostSectionCollapse({ rows: sectioned, collapsedGroups: collapsed })
    : sectioned
  return { rows, sectionRows }
}
