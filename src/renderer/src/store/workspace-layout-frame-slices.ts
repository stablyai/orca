// Today's store slices for the workspaces main's layout frames hold, built from the frames, the
// content facts beside them and this window's view (design phase E2a). Not called yet: the switch
// sets these slices from frames instead of restoring them from disk. Records come from the shared
// Serializer and slices from the window's own restore builders, so a frame shows what the same
// session restored from disk shows. Global selection (active workspace and tab) stays the view's;
// a remote server's workspaces stay the mirror's, so the caller passes only the ones frames own.
// Frames do not carry sleeping agent records, closed-tab records, default-tab marks or what a tab
// reattaches at startup; those stay main's records and today's restore until the switch moves them.

import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  CarriedSessionFields,
  DesktopLayoutView,
  LayoutContentFacts
} from '../../../shared/workspace-layout/workspace-layout-beside'
import { workspaceLayoutModelFromPublished } from '../../../shared/workspace-layout/workspace-layout-from-published'
import type {
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { projectHydratedBrowserSession } from './slices/browser/browser-hydration-state'
import { buildHydratedEditorSessionState } from './slices/editor/actions/hydrated-editor-session-state'
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
  /** Whether this window holds an editor file's record: frames carry only edit-mode files'. */
  holdsEditorFile?: (worktreeId: string, fileId: string) => boolean
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

export function buildLayoutFrameSlices({
  layouts,
  facts,
  view,
  holdsEditorFile
}: LayoutFrameSliceInput): LayoutFrameSlices {
  const liveTitles = liveTitlesByTabId(layouts, view)
  const saved = saveWorkspaceLayout({
    layout: workspaceLayoutModelFromPublished(LOCAL_EXECUTION_HOST_ID, layouts),
    desktopView: view,
    facts: withLiveTitles(facts, liveTitles),
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

  const tabs = buildHydratedTabState(session, workspaceKeys, holdsEditorFile)
  const editor = buildHydratedEditorSessionState(session, workspaceKeys, null)
  const browser = projectHydratedBrowserSession(
    {
      activeWorktreeId: null,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: editor.state.activeTabTypeByWorktree,
      openFiles: editor.state.openFiles,
      tabsByWorktree: rows.tabsByWorktree
    },
    session,
    workspaceKeys
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
    openFiles: editor.state.openFiles,
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
