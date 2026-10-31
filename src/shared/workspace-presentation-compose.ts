import type { Tab, TabGroup } from './tab-types'
import {
  sourceTabPresentation,
  workspaceSourceOwnsTab,
  workspaceEntityKey,
  type WorkspacePresentation,
  type WorkspaceSourceBaseline
} from './workspace-presentation'
import { reconcileWorkspacePresentation } from './workspace-presentation-reconcile'
/** A presentation places genuine entities once, retaining their actual raw workspace and command IDs. */
export function composeWorkspacePresentation(
  saved: WorkspacePresentation,
  sources: readonly { baseline: WorkspaceSourceBaseline; tabs: readonly Tab[] }[]
): {
  tabs: Tab[]
  groups: TabGroup[]
  layout: WorkspacePresentation['layout']
  activeGroupId: string | undefined
} {
  const raw = new Map<string, Tab>()
  for (const { baseline, tabs } of [...sources].sort(
    (a, b) =>
      Number(b.baseline.source.workspaceId === saved.displayWorkspaceId) -
      Number(a.baseline.source.workspaceId === saved.displayWorkspaceId)
  )) {
    for (const tab of tabs.filter((tab) => workspaceSourceOwnsTab(tab, baseline.source))) {
      const key = workspaceEntityKey(sourceTabPresentation(tab, baseline.source).entity)
      if (!raw.has(key)) {
        raw.set(key, tab)
      }
    }
  }
  const livePlacements = reconcileWorkspacePresentation(
    saved,
    sources.map(({ baseline, tabs }) => ({
      ...baseline,
      tabs: tabs
        .filter((tab) => workspaceSourceOwnsTab(tab, baseline.source))
        .map((tab) => sourceTabPresentation(tab, baseline.source))
    }))
  )
  const tabs = livePlacements.tabs.flatMap((placement) => {
    const tab = raw.get(workspaceEntityKey(placement.entity))
    if (!tab) {
      return []
    }
    const { entity: _entity, ...view } = placement
    return [
      { ...tab, ...view, executionHostId: placement.entity.hostId, worktreeId: tab.worktreeId }
    ]
  })
  return {
    tabs,
    groups: livePlacements.groups,
    layout: livePlacements.layout,
    activeGroupId: livePlacements.activeGroupId
  }
}
