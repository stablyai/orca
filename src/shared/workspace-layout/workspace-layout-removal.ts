import { removeGroupLayoutLeaf } from './tab-group-layout-tree'
import { withoutKey } from './stored-record-fields'
import { layoutContainsLeafId, removeLayoutLeaf } from './terminal-pane-tree'
import type {
  LayoutTerminalTab,
  WorkspaceLayout,
  WorkspaceLayoutModel
} from './workspace-layout-model'

export type TerminalTabLocation = { workspaceKey: string; tab: LayoutTerminalTab }

export function findTerminalTab(
  model: WorkspaceLayoutModel,
  terminalTabId: string
): TerminalTabLocation | null {
  for (const [workspaceKey, workspace] of Object.entries(model.workspaces)) {
    for (const tab of workspace.tabs) {
      if (tab.kind === 'terminal' && tab.entityId === terminalTabId) {
        return { workspaceKey, tab }
      }
    }
  }
  return null
}

/** Close emptied groups, including the last, to match persisted layout. */
export function removeTabFromWorkspace(workspace: WorkspaceLayout, tabId: string): WorkspaceLayout {
  let groupLayout = workspace.groupLayout
  const groups = workspace.groups.flatMap((group) => {
    if (!group.tabOrder.includes(tabId)) {
      return [group]
    }
    const tabOrder = group.tabOrder.filter((id) => id !== tabId)
    if (tabOrder.length === 0) {
      groupLayout = groupLayout
        ? (removeGroupLayoutLeaf(groupLayout, group.id) ?? undefined)
        : undefined
      return []
    }
    return [{ ...group, tabOrder }]
  })
  const next: WorkspaceLayout = {
    ...workspace,
    tabs: workspace.tabs.filter((tab) => tab.id !== tabId),
    groups
  }
  if (groupLayout) {
    next.groupLayout = groupLayout
  } else {
    delete next.groupLayout
  }
  return next
}

export function withWorkspace(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  workspace: WorkspaceLayout
): WorkspaceLayoutModel {
  return { ...model, workspaces: { ...model.workspaces, [workspaceKey]: workspace } }
}

/** Removes one pane and its data; a tab left without panes closes. */
export function retireTerminalPane(
  model: WorkspaceLayoutModel,
  location: TerminalTabLocation,
  leafId: string
): WorkspaceLayoutModel {
  const { workspaceKey, tab } = location
  const workspace = model.workspaces[workspaceKey]!
  const root = removeLayoutLeaf(tab.panes.root, leafId)
  let nextWorkspace: WorkspaceLayout
  if (!root) {
    nextWorkspace = removeTabFromWorkspace(workspace, tab.id)
  } else {
    const panes = { ...tab.panes, root }
    if (panes.chatLeafId === leafId) {
      delete panes.chatLeafId
    }
    nextWorkspace = {
      ...workspace,
      tabs: workspace.tabs.map((entry) => (entry.id === tab.id ? { ...tab, panes } : entry))
    }
  }
  return withWorkspace(model, workspaceKey, {
    ...nextWorkspace,
    leaves: withoutKey(nextWorkspace.leaves, leafId)
  })
}

export type ExitedSurface = {
  worktreeId: string
  terminalTabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}

/** Find the exited terminal’s pane; gone means removed, replaced means a different terminal/incarnation now owns it. */
export function locateExitedSurface(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface
): TerminalTabLocation | 'gone' | 'replaced' {
  const location = findTerminalTab(model, surface.terminalTabId)
  if (!location || !layoutContainsLeafId(location.tab.panes.root, surface.leafId)) {
    return 'gone'
  }
  const leaf = model.workspaces[location.workspaceKey]!.leaves?.[surface.leafId]
  if (
    surface.incarnationId &&
    leaf?.incarnationId &&
    leaf.incarnationId !== surface.incarnationId
  ) {
    return 'replaced'
  }
  return leaf?.ptyId && leaf.ptyId !== surface.ptyId ? 'replaced' : location
}

/** Retire the pane unless its terminal/incarnation was replaced; an already-removed pane is a no-op. */
export function retireExitedSurface(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface
): WorkspaceLayoutModel | null {
  const location = locateExitedSurface(model, surface)
  if (location === 'gone') {
    return model
  }
  return location === 'replaced' ? null : retireTerminalPane(model, location, surface.leafId)
}
