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

/** An emptied group closes, even the last one: an empty group is never saved, so it never stays. */
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

/**
 * Today's exit retirement: null when the pane now shows another terminal or incarnation (left
 * alone); else the model without the pane, unchanged when its tab no longer holds it.
 */
export function retireExitedSurface(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface
): WorkspaceLayoutModel | null {
  const location = findTerminalTab(model, surface.terminalTabId)
  const inTree = Boolean(location && layoutContainsLeafId(location.tab.panes.root, surface.leafId))
  if (!location || !inTree) {
    return model
  }
  const leaf = model.workspaces[location.workspaceKey]!.leaves?.[surface.leafId]
  if (
    surface.incarnationId &&
    leaf?.incarnationId &&
    leaf.incarnationId !== surface.incarnationId
  ) {
    return null
  }
  if (leaf?.ptyId && leaf.ptyId !== surface.ptyId) {
    return null
  }
  return retireTerminalPane(model, location, surface.leafId)
}
