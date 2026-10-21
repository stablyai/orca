// Prune rules for view records (design §1.4): what a save keeps of a record, and what a removed
// workspace takes with it. Reads never need these; they fall back (workspace-layout-views.ts).

import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import { filterRecord, withoutKey } from './stored-record-fields'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { editorFileKey, holdsEditorFileId } from './workspace-layout-editor-tab-file'
import type {
  LayoutTerminalTab,
  WorkspaceLayout,
  WorkspaceLayoutModel
} from './workspace-layout-model'
import type { LayoutViewRecord } from './workspace-layout-views'

type Workspaces = WorkspaceLayoutModel['workspaces']

function terminalTabs(workspace: WorkspaceLayout): LayoutTerminalTab[] {
  return workspace.tabs.flatMap((tab) => (tab.kind === 'terminal' ? [tab] : []))
}

/** Nulls an id the held workspace no longer has; a workspace the model does not hold is untouched. */
function clearMissingIds(
  byWorkspace: Record<string, string | null> | undefined,
  workspaces: Workspaces,
  holds: (workspace: WorkspaceLayout, id: string) => boolean
): Record<string, string | null> | undefined {
  if (!byWorkspace) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(byWorkspace).map(([key, id]) => {
      const workspace = workspaces[key]
      return [key, id === null || !workspace || holds(workspace, id) ? id : null]
    })
  )
}

const holdsId =
  (ids: (workspace: WorkspaceLayout) => readonly string[]) =>
  (workspace: WorkspaceLayout, id: string): boolean =>
    ids(workspace).includes(id)

/** Keeps a held workspace's entries for ids it still has; other workspaces are untouched. */
function keepHeldIds<T>(
  byWorkspace: Record<string, Record<string, T>>,
  workspaces: Workspaces,
  ids: (workspace: WorkspaceLayout) => readonly string[]
): Record<string, Record<string, T>> {
  return Object.fromEntries(
    Object.entries(byWorkspace).map(([key, byId]) => {
      const workspace = workspaces[key]
      const held = workspace ? ids(workspace) : null
      return [key, held ? (filterRecord(byId, (id) => held.includes(id)) ?? {}) : byId]
    })
  )
}

const tabIds = (workspace: WorkspaceLayout): string[] => workspace.tabs.map((tab) => tab.id)
const groupIds = (workspace: WorkspaceLayout): string[] => workspace.groups.map((group) => group.id)
const fileKeys = (workspace: WorkspaceLayout): string[] =>
  workspace.editorFiles?.map(editorFileKey) ?? []
const browserTabIds = (workspace: WorkspaceLayout): string[] =>
  workspace.browserTabs?.map((tab) => tab.id) ?? []
const terminalTabIds = (workspace: WorkspaceLayout): string[] =>
  terminalTabs(workspace).map((tab) => tab.entityId)

/**
 * What a save keeps of a view record, given the model of the same partition: entries naming a
 * group, tab, pane, file or browser tab the model no longer holds are dropped or reset the way
 * today's writer resets them, so the Serializer writes the same disk fields either way.
 */
export function pruneViewRecord(
  record: LayoutViewRecord,
  layout: WorkspaceLayoutModel
): LayoutViewRecord {
  const { workspaces } = layout
  const groups = keepHeldIds(record.groups, workspaces, groupIds)
  for (const [key, byGroup] of Object.entries(groups)) {
    for (const group of workspaces[key]?.groups ?? []) {
      const selection = byGroup[group.id]
      if (selection) {
        const { activeTabId, recentTabIds } = selection
        byGroup[group.id] = {
          activeTabId: activeTabId && group.tabOrder.includes(activeTabId) ? activeTabId : null,
          ...(recentTabIds
            ? { recentTabIds: recentTabIds.filter((id) => group.tabOrder.includes(id)) }
            : {})
        }
      }
    }
  }
  const leafIdsByTab = new Map(
    Object.values(workspaces).flatMap((workspace) =>
      terminalTabs(workspace).map((tab) => [
        tab.entityId,
        collectLayoutLeafIdsInOrder(tab.panes.root)
      ])
    )
  )
  const panes: LayoutViewRecord['panes'] = {}
  for (const [tabId, { activeLeafId, expandedLeafId }] of Object.entries(record.panes)) {
    const leafIds = leafIdsByTab.get(tabId)
    if (leafIds) {
      panes[tabId] = {
        activeLeafId:
          activeLeafId === null || leafIds.includes(activeLeafId)
            ? activeLeafId
            : (leafIds[0] ?? null),
        expandedLeafId: expandedLeafId && leafIds.includes(expandedLeafId) ? expandedLeafId : null
      }
    }
  }
  const activeGroups = record.activeGroupIdByWorktree
  const pruned: LayoutViewRecord = {
    ...record,
    groups,
    lastFocusedAt: keepHeldIds(record.lastFocusedAt, workspaces, tabIds),
    panes,
    editorDrafts: keepHeldIds(record.editorDrafts, workspaces, fileKeys)
  }
  if (activeGroups) {
    pruned.activeGroupIdByWorktree = filterRecord(
      activeGroups,
      (key, groupId) => !workspaces[key] || groupIds(workspaces[key]).includes(groupId)
    )
  }
  if (record.activeTabIdByWorktree) {
    pruned.activeTabIdByWorktree = clearMissingIds(
      record.activeTabIdByWorktree,
      workspaces,
      holdsId(terminalTabIds)
    )
  }
  if (record.activeFileIdByWorktree) {
    pruned.activeFileIdByWorktree = clearMissingIds(
      record.activeFileIdByWorktree,
      workspaces,
      holdsEditorFileId
    )
  }
  if (record.activeBrowserTabIdByWorktree) {
    pruned.activeBrowserTabIdByWorktree = clearMissingIds(
      record.activeBrowserTabIdByWorktree,
      workspaces,
      holdsId(browserTabIds)
    )
  }
  return pruned
}

/**
 * A workspace left the catalog: its selection goes with it, field for field as the Store's owner
 * removal drops it from a stored session today. `workspace` is its layout before the removal.
 */
export function removeWorkspaceFromView(
  record: LayoutViewRecord,
  workspaceKey: string,
  workspace: WorkspaceLayout | undefined
): LayoutViewRecord {
  const removedTerminalTabIds = new Set(workspace ? terminalTabIds(workspace) : [])
  const next: LayoutViewRecord = {
    ...record,
    groups: withoutKey(record.groups, workspaceKey) ?? {},
    lastFocusedAt: withoutKey(record.lastFocusedAt, workspaceKey) ?? {},
    panes: filterRecord(record.panes, (tabId) => !removedTerminalTabIds.has(tabId)) ?? {},
    editorDrafts: withoutKey(record.editorDrafts, workspaceKey) ?? {}
  }
  next.activeFileIdByWorktree = withoutKey(record.activeFileIdByWorktree, workspaceKey)
  next.activeBrowserTabIdByWorktree = withoutKey(record.activeBrowserTabIdByWorktree, workspaceKey)
  next.activeTabTypeByWorktree = withoutKey(record.activeTabTypeByWorktree, workspaceKey)
  next.activeTabIdByWorktree = withoutKey(record.activeTabIdByWorktree, workspaceKey)
  next.activeGroupIdByWorktree = withoutKey(record.activeGroupIdByWorktree, workspaceKey)
  if (record.lastVisitedAtByWorktreeId) {
    next.lastVisitedAtByWorktreeId = filterRecord(record.lastVisitedAtByWorktreeId, (key) => {
      const rawId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      return key !== workspaceKey && rawId !== workspaceKey
    })
  }
  if (record.activeWorkspaceKey === workspaceKey) {
    next.activeWorkspaceKey = null
  }
  if (record.activeWorktreeId === workspaceKey) {
    next.activeWorktreeId = null
  }
  if (record.activeTabId !== null && removedTerminalTabIds.has(record.activeTabId)) {
    next.activeTabId = null
  }
  return next
}
