// Steps every command shares: lookups, placing a tab in the one tab order, and result shapes.

import { insertTabIdIntoOrder } from './tab-order'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import type {
  LayoutApplyResult,
  LayoutCommandResult,
  LayoutContext,
  LayoutEffects,
  LayoutRefusalCode
} from './workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutLeaf,
  type LayoutTab,
  type LayoutTerminalTab,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'

export type Applied = LayoutApplyResult<WorkspaceLayoutModel>

export const refuse = (code: LayoutRefusalCode): Applied => ({ ok: false, code })

export function applied(
  model: WorkspaceLayoutModel,
  result: LayoutCommandResult = {},
  effects: Partial<LayoutEffects> = {}
): Applied {
  return {
    ok: true,
    model,
    result,
    effects: { stopPtyIds: effects.stopPtyIds ?? [], startPaneKeys: effects.startPaneKeys ?? [] }
  }
}

/** A workspace's first tab creates its entry; its worktree id is its key unless the runtime opened it first. */
export function workspaceOrEmpty(model: WorkspaceLayoutModel, key: string): WorkspaceLayout {
  return model.workspaces[key] ?? { worktreeId: key, tabs: [], groups: [] }
}

export function findTab(workspace: WorkspaceLayout, tabId: string): LayoutTab | undefined {
  return workspace.tabs.find((tab) => tab.id === tabId)
}

export function findTerminal(
  workspace: WorkspaceLayout,
  tabId: string
): LayoutTerminalTab | undefined {
  const tab = findTab(workspace, tabId)
  return tab?.kind === 'terminal' ? tab : undefined
}

export function replaceTab(workspace: WorkspaceLayout, tab: LayoutTab): WorkspaceLayout {
  return { ...workspace, tabs: workspace.tabs.map((entry) => (entry.id === tab.id ? tab : entry)) }
}

export function updateTab(
  model: WorkspaceLayoutModel,
  key: string,
  tab: LayoutTab,
  result: LayoutCommandResult = {}
): Applied {
  return applied(withWorkspace(model, key, replaceTab(model.workspaces[key]!, tab)), result)
}

export function leafIdsOf(tab: LayoutTerminalTab): string[] {
  return collectLayoutLeafIdsInOrder(tab.panes.root)
}

export function boundPtyIds(workspace: WorkspaceLayout, tab: LayoutTab): string[] {
  return tab.kind === 'terminal'
    ? leafIdsOf(tab).flatMap((leafId) => workspace.leaves?.[leafId]?.ptyId ?? [])
    : []
}

/** The workspace with one pane's data replaced; a pane with no data keeps no record. */
export function setLeaf(
  workspace: WorkspaceLayout,
  leafId: string,
  leaf: LayoutLeaf
): WorkspaceLayout {
  const leaves = { ...workspace.leaves, [leafId]: leaf }
  if (Object.keys(leaf).length === 0) {
    delete leaves[leafId]
  }
  return { ...workspace, leaves }
}

/** The terminal tab and pane a pane key names in this workspace. */
export function locatePane(
  workspace: WorkspaceLayout,
  paneKey: string
): { tab: LayoutTerminalTab; leafId: string } | null {
  for (const tab of workspace.tabs) {
    if (tab.kind !== 'terminal') {
      continue
    }
    const leafId = leafIdsOf(tab).find(
      (candidate) => paneKeyOf(tab.entityId, candidate) === paneKey
    )
    if (leafId) {
      return { tab, leafId }
    }
  }
  return null
}

export type TabPlacement = { groupId?: string; afterTabId?: string; index?: number }

/**
 * Puts a new tab in the one tab order: the named group, else the anchor's, else the first; a
 * workspace with no group gets one. Pinned tabs stay ahead of unpinned ones.
 */
export function placeNewTab(
  workspace: WorkspaceLayout,
  tab: LayoutTab,
  placement: TabPlacement,
  context: LayoutContext
): WorkspaceLayout {
  const tabs = [...workspace.tabs, tab]
  const anchorGroup = placement.afterTabId
    ? workspace.groups.find((group) => group.tabOrder.includes(placement.afterTabId!))
    : undefined
  let group =
    workspace.groups.find((entry) => entry.id === placement.groupId) ??
    anchorGroup ??
    workspace.groups[0]
  const groups = [...workspace.groups]
  if (!group) {
    group = { id: context.mintId(), tabOrder: [] }
    groups.push(group)
  }
  let tabOrder: string[]
  if (placement.index !== undefined) {
    tabOrder = group.tabOrder.filter((id) => id !== tab.id)
    tabOrder.splice(Math.max(0, Math.min(placement.index, tabOrder.length)), 0, tab.id)
  } else {
    const anchor = anchorGroup === group ? placement.afterTabId : undefined
    tabOrder = insertTabIdIntoOrder(group.tabOrder, tabs, tab.id, tab.isPinned === true, anchor)
  }
  const placed = { ...group, tabOrder }
  return {
    ...workspace,
    tabs,
    groups: groups.map((entry) => (entry.id === placed.id ? placed : entry))
  }
}
