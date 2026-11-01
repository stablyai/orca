// Build main-owned frame slices through Serializer/restore builders (E2a); global selection stays window-owned, remote server workspaces mirror-owned. Sleeping/closed records, default marks and startup reattach remain outside frames.

import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  CarriedSessionFields,
  DesktopLayoutView,
  LayoutContentFacts
} from '../../../shared/workspace-layout/workspace-layout-beside'
import { workspaceLayoutModelFromPublished } from '../../../shared/workspace-layout/workspace-layout-from-published'
import { editorTabShowsFile } from '../../../shared/workspace-layout/workspace-layout-editor-tab-file'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { projectHydratedBrowserSession } from './slices/browser/browser-hydration-state'
import { buildHydratedEditorSessionState } from './slices/editor/actions/hydrated-editor-session-state'
import { openFileOfLayoutEditorView } from './slices/editor/tabs/open-file-layout-view'
import type { OpenFile } from './slices/editor/types/open-file'
import { editorTabLabelOf } from './slices/editor/tabs/editor-tab-label'
import { isEditorTabContentType } from './slices/editor/tabs/editor-tab-content-type'
import type { EditorTabView } from '../../../shared/editor-tab-view-types'
import { migrateHydratedEditorTabsAndGroups } from './slices/editor/file-ids/hydrated-editor-file-ids'
import { buildHydratedTabState } from './slices/tabs-hydration'
import { buildByIdIndex } from './slices/worktree-by-id-index'
import { restoreActiveTabIdByWorktree } from './terminals/workspace-terminal-active-tabs'
import { buildWorkspaceTerminalLayoutPlan } from './terminals/workspace-terminal-layout-plan'
import { buildWorkspaceTerminalRowPlan } from './terminals/workspace-terminal-row-plan'
import type { AppState } from './types'
import type { WorkspaceLayoutCache } from './workspace-layout-cache'

export type LayoutFrameSliceInput = {
  /** Workspace key → its layout as the last frame published it. */
  layouts: WorkspaceLayoutCache
  facts: LayoutContentFacts
  view: DesktopLayoutView
}

export type LayoutFrameSlices = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'activeTabIdByWorktree'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'activeGroupIdByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
  | 'activeFileIdByWorktree'
  | 'browserTabsByWorktree'
  | 'browserPagesByWorkspace'
  | 'remoteBrowserPageHandlesByPageId'
  | 'activeBrowserTabIdByWorktree'
  | 'activeTabTypeByWorktree'
>

const NOTHING_CARRIED: CarriedSessionFields = {
  unownedTerminalLayouts: {},
  unplacedSleepingRecords: {},
  unplacedIncarnations: {},
  unplacedClosedTabs: {}
}

/** A terminal's title is the live title of the pane this view focuses, when main reports one. */
export function shownLiveTitle(
  tab: PublishedTab,
  focusedLeafId: string | null | undefined
): string | undefined {
  const panes = tab.terminal?.panes ?? []
  return (panes.find((pane) => pane.leafId === focusedLeafId) ?? panes[0])?.liveTitle
}

/** Terminal entity id → the live title main reports for the pane this view focuses. */
function liveTitlesByTabId(
  layouts: WorkspaceLayoutCache,
  view: DesktopLayoutView
): Map<string, string> {
  const titles = new Map<string, string>()
  for (const tab of Object.values(layouts).flatMap((layout) => layout.tabs)) {
    const liveTitle = shownLiveTitle(tab, view.panes[tab.entityId]?.activeLeafId)
    if (liveTitle !== undefined) {
      titles.set(tab.entityId, liveTitle)
    }
  }
  return titles
}

function withLiveTitles(
  facts: LayoutContentFacts,
  liveTitles: ReadonlyMap<string, string>
): LayoutContentFacts {
  const terminalRows = { ...facts.terminalRows }
  for (const [tabId, title] of liveTitles) {
    terminalRows[tabId] = { ...terminalRows[tabId], title }
  }
  return { ...facts, terminalRows }
}

/** Each tab-bar entry names the host its frame names, which the frame alone knows per tab. */
function stampExecutionHosts(
  unifiedTabs: NonNullable<WorkspaceSessionState['unifiedTabs']>,
  layouts: Readonly<Record<string, PublishedWorkspaceLayout>>
): NonNullable<WorkspaceSessionState['unifiedTabs']> {
  return Object.fromEntries(
    Object.entries(unifiedTabs).map(([key, entries]) => {
      const hostByTabId = new Map(layouts[key]?.tabs.map((tab) => [tab.id, tab.executionHostId]))
      return [
        key,
        entries.map((entry) => ({
          ...entry,
          executionHostId: hostByTabId.get(entry.id) ?? entry.executionHostId
        }))
      ]
    })
  )
}

/** A group shows the view's tab, else its first, as the startup reconcile picks today. */
function withShownTabs(
  groupsByWorktree: AppState['groupsByWorktree']
): AppState['groupsByWorktree'] {
  return Object.fromEntries(
    Object.entries(groupsByWorktree).map(([key, groups]) => [
      key,
      groups.map((group) =>
        group.activeTabId === null && group.tabOrder.length > 0
          ? { ...group, activeTabId: group.tabOrder[0]! }
          : group
      )
    ])
  )
}

const fileKey = (worktreeId: string, fileId: string): string => `${worktreeId}\0${fileId}`

type FramedViewFile = { view: EditorTabView; file: OpenFile }

/** Each editor tab's open file as its frame's view rebuilds it, by workspace and file id. */
function framedViewFiles(layouts: WorkspaceLayoutCache): Map<string, FramedViewFile> {
  const files = new Map<string, FramedViewFile>()
  for (const [key, layout] of Object.entries(layouts)) {
    for (const tab of layout.tabs) {
      if (tab.editorView && !files.has(fileKey(key, tab.entityId))) {
        files.set(fileKey(key, tab.entityId), {
          view: tab.editorView.view,
          file: openFileOfLayoutEditorView(tab.editorView, { ...tab, worktreeId: key })
        })
      }
    }
  }
  return files
}

/** A file a frame's view shows: its saved record takes the view, else the view rebuilds it. */
function withFramedViewFiles(
  openFiles: OpenFile[],
  framed: ReadonlyMap<string, FramedViewFile>
): OpenFile[] {
  if (framed.size === 0) {
    return openFiles
  }
  const placed = new Set<string>()
  const files = openFiles.map((file) => {
    const framedFile = framed.get(fileKey(file.worktreeId, file.id))
    if (!framedFile) {
      return file
    }
    placed.add(fileKey(file.worktreeId, file.id))
    // An edit tab on a conflicted file: the saved record is the file, the view its conflict.
    return { ...file, ...framedFile.view }
  })
  const rebuilt = [...framed].flatMap(([key, { file }]) => (placed.has(key) ? [] : [file]))
  return [...files, ...rebuilt]
}

/** The label the window's own open gives a frame's editor tab, from its view or its file record. */
function frameEditorTabLabel(tab: PublishedTab, layout: PublishedWorkspaceLayout): string | null {
  if (tab.editorView) {
    return editorTabLabelOf({
      mode: tab.editorView.view.mode,
      relativePath: tab.editorView.file.relativePath
    })
  }
  const file = layout.editorFiles.find((entry) =>
    editorTabShowsFile(tab.entityId, entry, layout.worktreeId)
  )
  return file ? file.relativePath : null
}

/** An editor tab only a frame drew (the window never opened it) takes the label its open would. */
function withEditorTabLabels(
  facts: LayoutContentFacts,
  layouts: WorkspaceLayoutCache
): LayoutContentFacts {
  const tabLabels = { ...facts.tabLabels }
  for (const [key, layout] of Object.entries(layouts)) {
    for (const tab of layout.tabs) {
      const label =
        isEditorTabContentType(tab.kind) && !tabLabels[key]?.[tab.id]
          ? frameEditorTabLabel(tab, layout)
          : null
      if (label) {
        tabLabels[key] = { ...tabLabels[key], [tab.id]: label }
      }
    }
  }
  return { ...facts, tabLabels }
}

export function buildLayoutFrameSlices({
  layouts,
  facts,
  view
}: LayoutFrameSliceInput): LayoutFrameSlices {
  const liveTitles = liveTitlesByTabId(layouts, view)
  const saved = saveWorkspaceLayout({
    layout: workspaceLayoutModelFromPublished(LOCAL_EXECUTION_HOST_ID, layouts),
    desktopView: view,
    facts: withEditorTabLabels(withLiveTitles(facts, liveTitles), layouts),
    carried: NOTHING_CARRIED
  })
  const session = { ...saved, unifiedTabs: stampExecutionHosts(saved.unifiedTabs ?? {}, layouts) }
  // The frames are the catalog: main publishes only workspaces it holds.
  const workspaceKeys = new Set(Object.keys(layouts))

  // Restore resets agent titles because a prior session's agents have exited; a live one has not.
  const rows = buildWorkspaceTerminalRowPlan(session, workspaceKeys, liveTitles)
  const terminalLayoutsByTabId = buildWorkspaceTerminalLayoutPlan({
    ownershipTransfersByTabId: new Map(),
    ownershipTransferTabIds: new Set(),
    releasedPtyIdsByTabId: rows.releasedPtyIdsByTabId,
    session,
    tabById: buildByIdIndex(Object.values(rows.tabsByWorktree).flat()),
    validTabIds: rows.validTabIds
  })
  const activeTabIdByWorktree = restoreActiveTabIdByWorktree({
    session,
    validWorktreeIds: workspaceKeys,
    validTabIds: rows.validTabIds,
    canonicalTabIdBySubsumedTabId: rows.canonicalTabIdBySubsumedTabId,
    tabsByWorktree: rows.tabsByWorktree,
    // Only a session saved before the per-workspace map reads these.
    activeWorktreeId:
      view.activeWorktreeId && workspaceKeys.has(view.activeWorktreeId)
        ? view.activeWorktreeId
        : null,
    activeTabId:
      view.activeTabId && rows.validTabIds.has(view.activeTabId) ? view.activeTabId : null
  })

  const framed = framedViewFiles(layouts)
  // A diff, conflict or check tab is drawn from its view: every window open sends one.
  const tabs = buildHydratedTabState(session, workspaceKeys, (worktreeId, fileId) =>
    framed.has(fileKey(worktreeId, fileId))
  )
  const editor = buildHydratedEditorSessionState(session, workspaceKeys, null)
  const openFiles = withFramedViewFiles(editor.state.openFiles, framed)
  const browser = projectHydratedBrowserSession(
    {
      activeWorktreeId: null,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: editor.state.activeTabTypeByWorktree,
      openFiles,
      tabsByWorktree: rows.tabsByWorktree
    },
    session,
    workspaceKeys,
    // A frame redraws the window's own selection: one it never made stays none.
    { unchosenStaysUnset: true }
  )
  const editorTabs = {
    ...tabs,
    ...migrateHydratedEditorTabsAndGroups(tabs, editor.editorFileIdMigrationsByWorktree)
  }
  return {
    tabsByWorktree: rows.tabsByWorktree,
    terminalLayoutsByTabId,
    activeTabIdByWorktree,
    ...editorTabs,
    groupsByWorktree: withShownTabs(editorTabs.groupsByWorktree),
    openFiles,
    editorDrafts: editor.state.editorDrafts,
    markdownFrontmatterVisible: editor.state.markdownFrontmatterVisible,
    activeFileIdByWorktree: editor.state.activeFileIdByWorktree,
    browserTabsByWorktree: browser.browserTabsByWorktree,
    browserPagesByWorkspace: browser.browserPagesByWorkspace,
    remoteBrowserPageHandlesByPageId: browser.remoteBrowserPageHandlesByPageId,
    activeBrowserTabIdByWorktree: browser.activeBrowserTabIdByWorktree,
    activeTabTypeByWorktree: browser.activeTabTypeByWorktree
  }
}
