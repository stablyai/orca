// The per-view store (design §1.4): each view's own selection, kept beside the layout and never
// published to another view. A close moves each view's shown tab when it is applied; anything else
// a record names that a later change removed falls back at read time and is pruned at save.

import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import type { DesktopLayoutView } from './workspace-layout-beside'
import type { WorkspaceLayout } from './workspace-layout-model'

/** The one workspace window of an app instance. */
export const DESKTOP_VIEW_ID = 'desktop'

/** `device:<pairedDeviceId>` for a phone or paired web client. CLI and orchestration have no view. */
export type LayoutViewId = typeof DESKTOP_VIEW_ID | `device:${string}`

export function deviceViewId(pairedDeviceId: string): LayoutViewId {
  return `device:${pairedDeviceId}`
}

/**
 * One shape for every view. The desktop's is also written into today's on-disk selection fields
 * (the Serializer), so a downgraded build restores the same selection.
 */
export type LayoutViewRecord = DesktopLayoutView

export type LayoutViewStore = Readonly<Partial<Record<LayoutViewId, LayoutViewRecord>>>

export function emptyLayoutViewRecord(): LayoutViewRecord {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    groups: {},
    lastFocusedAt: {},
    panes: {},
    editorDrafts: {}
  }
}

/** A view seen for the first time starts empty; it never inherits another view's selection. */
export function viewRecordOf(store: LayoutViewStore, viewId: LayoutViewId): LayoutViewRecord {
  return store[viewId] ?? emptyLayoutViewRecord()
}

/** Unsaved editor drafts are the desktop's only (design §1.4). */
export function setViewRecord(
  store: LayoutViewStore,
  viewId: LayoutViewId,
  record: LayoutViewRecord
): LayoutViewStore {
  return {
    ...store,
    [viewId]: viewId === DESKTOP_VIEW_ID ? record : { ...record, editorDrafts: {} }
  }
}

/** A paired device was removed: its record goes with it. */
export function forgetView(store: LayoutViewStore, viewId: LayoutViewId): LayoutViewStore {
  if (!Object.hasOwn(store, viewId)) {
    return store
  }
  const next = { ...store }
  delete next[viewId]
  return next
}

export type ResolvedPaneSelection = { activeLeafId: string | null; expandedLeafId: string | null }

export type ResolvedWorkspaceSelection = {
  activeGroupId: string | null
  /** Group id → its shown tab, and its tabs most recent last. */
  groups: Record<string, { activeTabId: string | null; recentTabIds: string[] }>
  /** Terminal tab id (`entityId`) → focused and expanded pane. */
  panes: Record<string, ResolvedPaneSelection>
  activeFileId: string | null
  activeBrowserTabId: string | null
}

/**
 * The group's shown tab: the recorded one, else the most recent still there, else the first. A
 * close moves the record to the neighbour when applied (workspace-layout-view-tab-closes.ts); this
 * covers a record that names a tab it never saw leave, such as one loaded from disk.
 */
function resolveGroupTab(
  tabOrder: readonly string[],
  selection: { activeTabId: string | null; recentTabIds?: string[] } | undefined
): { activeTabId: string | null; recentTabIds: string[] } {
  const recentTabIds = (selection?.recentTabIds ?? []).filter((id) => tabOrder.includes(id))
  const recorded = selection?.activeTabId
  const activeTabId =
    recorded && tabOrder.includes(recorded)
      ? recorded
      : (recentTabIds.at(-1) ?? tabOrder[0] ?? null)
  return { activeTabId, recentTabIds }
}

/** What a view shows in one workspace, with every id that no longer exists fallen back. */
export function resolveWorkspaceSelection(
  record: LayoutViewRecord,
  workspaceKey: string,
  workspace: WorkspaceLayout
): ResolvedWorkspaceSelection {
  const groups: ResolvedWorkspaceSelection['groups'] = {}
  for (const group of workspace.groups) {
    groups[group.id] = resolveGroupTab(group.tabOrder, record.groups[workspaceKey]?.[group.id])
  }
  const panes: ResolvedWorkspaceSelection['panes'] = {}
  for (const tab of workspace.tabs) {
    if (tab.kind !== 'terminal') {
      continue
    }
    const leafIds = collectLayoutLeafIdsInOrder(tab.panes.root)
    const recorded = record.panes[tab.entityId]
    panes[tab.entityId] = {
      activeLeafId:
        recorded?.activeLeafId && leafIds.includes(recorded.activeLeafId)
          ? recorded.activeLeafId
          : (leafIds[0] ?? null),
      expandedLeafId:
        recorded?.expandedLeafId && leafIds.includes(recorded.expandedLeafId)
          ? recorded.expandedLeafId
          : null
    }
  }
  const recordedGroup = record.activeGroupIdByWorktree?.[workspaceKey]
  const activeFileId = record.activeFileIdByWorktree?.[workspaceKey]
  const activeBrowserTabId = record.activeBrowserTabIdByWorktree?.[workspaceKey]
  return {
    activeGroupId:
      recordedGroup && Object.hasOwn(groups, recordedGroup)
        ? recordedGroup
        : (workspace.groups[0]?.id ?? null),
    groups,
    panes,
    activeFileId: workspace.editorFiles?.some((file) => file.filePath === activeFileId)
      ? (activeFileId ?? null)
      : null,
    activeBrowserTabId: workspace.browserTabs?.some((tab) => tab.id === activeBrowserTabId)
      ? (activeBrowserTabId ?? null)
      : null
  }
}
