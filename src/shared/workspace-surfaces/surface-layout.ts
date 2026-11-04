import type { LayoutTab, WorkspaceLayout } from '../workspace-layout/workspace-layout-model'
import type { SurfaceContent, WorkspaceSurface } from './surface-content'
import { surfaceLayoutTab } from './surface-content'
import { collectLayoutLeafIdsInOrder } from '../workspace-layout/terminal-pane-tree'

/** A snapshot supplies presentation; only canonical rows can supply open contents or bindings. */
export function projectSurfaceWorkspace(
  workspaceId: string,
  view: WorkspaceLayout | undefined,
  surfaces: readonly WorkspaceSurface[],
  chatVerified = true,
  unresolvedNativeSessionIds: ReadonlySet<string> = new Set()
): WorkspaceLayout {
  const views = new Map(view?.tabs.map((tab) => [tab.id, tab]))
  const authoritative = new Set(
    surfaces
      .filter((surface) => surface.workspaceId === workspaceId)
      .map((surface) => surface.hostTabId)
  )
  const tabs: LayoutTab[] = (view?.tabs ?? []).filter(
    (tab) =>
      tab.kind !== 'terminal' &&
      (tab.kind !== 'agent-session' ||
        ((!chatVerified || unresolvedNativeSessionIds.has(tab.entityId)) &&
          !authoritative.has(tab.id)))
  )
  const leaves = { ...view?.leaves }
  for (const tab of view?.tabs ?? []) {
    if (tab.kind === 'terminal') {
      for (const leafId of collectLayoutLeafIdsInOrder(tab.panes.root)) {
        delete leaves[leafId]
      }
    }
  }
  for (const surface of surfaces) {
    if (surface.workspaceId !== workspaceId || surface.content === null) {
      continue
    }
    const open: WorkspaceSurface & { content: SurfaceContent } = {
      ...surface,
      content: surface.content
    }
    tabs.push(surfaceLayoutTab(open, views.get(surface.hostTabId)))
    if (surface.content.kind === 'terminal') {
      for (const [leafId, leaf] of Object.entries(surface.content.leaves)) {
        const facts = view?.leaves?.[leafId]
        leaves[leafId] = {
          ...(facts?.title !== undefined ? { title: facts.title } : {}),
          ...(facts?.lastGrid !== undefined ? { lastGrid: facts.lastGrid } : {}),
          ...leaf.facts
        }
      }
    }
  }
  const retained = new Set(tabs.map((tab) => tab.id))
  const placed = new Set<string>()
  const groups = (view?.groups ?? []).map((group) => ({
    ...group,
    tabOrder: group.tabOrder.filter((id) => {
      if (!retained.has(id) || placed.has(id)) {
        return false
      }
      placed.add(id)
      return true
    })
  }))
  const missing = tabs.filter((tab) => !placed.has(tab.id)).map((tab) => tab.id)
  if (missing.length > 0) {
    if (groups[0]) {
      groups[0] = { ...groups[0], tabOrder: [...groups[0].tabOrder, ...missing] }
    } else {
      groups.push({ id: `surface-group:${workspaceId}`, tabOrder: missing })
    }
  }
  return {
    ...view,
    worktreeId: view?.worktreeId ?? workspaceId,
    tabs,
    groups: groups.filter((group) => group.tabOrder.length > 0),
    leaves
  }
}
