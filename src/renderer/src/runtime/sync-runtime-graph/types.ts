import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { AppState } from '@/store/types'
import type { RuntimeMobileTerminalTheme } from '../../../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'

export type RuntimeMobileSessionSyncKey = {
  // Reference changes signal layout/title updates without stringifying thousands of tabs.
  terminalLayoutsByTabId: AppState['terminalLayoutsByTabId']
  runtimePaneTitlesByTabId: AppState['runtimePaneTitlesByTabId']
  nativeChatLaunchDraftByTabId: AppState['nativeChatLaunchDraftByTabId']
  folderWorkspaces: AppState['folderWorkspaces']
  groupsByWorktree: AppState['groupsByWorktree']
  activeGroupIdByWorktree: AppState['activeGroupIdByWorktree']
  layoutByWorktree: AppState['layoutByWorktree']
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
  tabBarOrderByWorktree: AppState['tabBarOrderByWorktree']
  activeFileId: AppState['activeFileId']
  activeFileIdByWorktree: AppState['activeFileIdByWorktree']
  activeTabType: AppState['activeTabType']
  activeTabTypeByWorktree: AppState['activeTabTypeByWorktree']
  activeTabId: AppState['activeTabId']
  activeBrowserTabIdByWorktree: AppState['activeBrowserTabIdByWorktree']
  agentStatusEpoch: number
  agentStatusProjection: string
  generatedTabTitlesEnabled: boolean
  systemPrefersDark: boolean | null
  terminalThemeProjection: string
  tabsProjection: string
  openFilesProjection: string
  browserProjection: string
  editorDraftsProjection: string
}

export type RegisteredTerminalTab = {
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getContainer: () => HTMLDivElement | null
  getPtyIdForPane: (paneId: number) => string | null
  getTabWideAgentHintLeafId: () => string | null
}

export type OpenFileByWorktreeAndId = Map<string, Map<string, AppState['openFiles'][number]>>
export type OpenFileIndexes = {
  byWorktreeAndId: OpenFileByWorktreeAndId
  idsByWorktree: Map<string, string[]>
}
export type FallbackEditorTabTarget = {
  tabId: string
  groupId: string | null
}
export type TabsProjectionCacheEntry = {
  tabs: NonNullable<AppState['tabsByWorktree'][string]>
  worktreeIdJson: string
  projection: string
}
export type TabsProjectionCache = {
  source: AppState['tabsByWorktree']
  entries: Map<string, TabsProjectionCacheEntry>
  projection: string
}
export type OpenFilesProjectionCacheEntry = {
  file: AppState['openFiles'][number]
  projection: string
}
export type OpenFilesProjectionCache = {
  source: AppState['openFiles']
  entries: Map<string, OpenFilesProjectionCacheEntry>
  projection: string
}
export type BrowserWorkspacesProjectionCacheEntry = {
  workspaces: NonNullable<AppState['browserTabsByWorktree'][string]>
  keyJson: string
  projection: string
}
export type BrowserWorkspacesProjectionCache = {
  source: AppState['browserTabsByWorktree']
  entries: Map<string, BrowserWorkspacesProjectionCacheEntry>
  projection: string
}
export type BrowserPagesProjectionCacheEntry = {
  pages: NonNullable<AppState['browserPagesByWorkspace'][string]>
  keyJson: string
  projection: string
}
export type BrowserPagesProjectionCache = {
  source: AppState['browserPagesByWorkspace']
  entries: Map<string, BrowserPagesProjectionCacheEntry>
  projection: string
}
/** One dirty file's FNV draft stamp plus its pre-serialized projection fragment. */
export type EditorDraftHashCacheEntry = {
  content: string
  hash: string
  fileIdJson: string
  projection: string
}
export type EditorDraftHashCache = {
  source: AppState['editorDrafts']
  entries: Map<string, EditorDraftHashCacheEntry>
  hashByFileId: Map<string, string>
  projection: string
}
export type AgentStatusProjectionCacheEntry = {
  entry: AppState['agentStatusByPaneKey'][string]
  projection: string
}
export type AgentStatusProjectionCache = {
  source: AppState['agentStatusByPaneKey']
  entries: Map<string, AgentStatusProjectionCacheEntry>
  projection: string
}
export type MobileSessionAgentStatusByWorktree = ReadonlyMap<
  string,
  ReadonlyMap<string, AppState['agentStatusByPaneKey'][string]>
>
/** Slices shared by every worktree in one publication; derived from `AppState` exactly once. */
export type MobileSessionPublicationInputs = {
  browserTabsByWorktree: AppState['browserTabsByWorktree']
  openFileIndexes: OpenFileIndexes
  editorDraftVersionByFileId: ReadonlyMap<string, string>
  agentStatusByWorktreeId: MobileSessionAgentStatusByWorktree
  generatedTitlesEnabled: boolean
  terminalTheme: RuntimeMobileTerminalTheme | undefined
}
/**
 * Live PaneManager/DOM reads for one mounted terminal tab, captured once per
 * publication.
 *
 * Why: builders read this instead of the registry, so live state the memo
 * cannot witness is unrepresentable — mounted worktrees memoize like the rest
 * instead of rebuilding on every publication.
 */
export type MountedTerminalSurfaceCapture = {
  paneLeafIds: readonly string[]
  hasLiveActivePane: boolean
  liveActiveLeafId: string | null
  liveLayoutRoot: TerminalPaneLayoutNode | null
  numericPaneIdByLeafId: ReadonlyMap<string, number | null>
  ptyIdByNumericPaneId: ReadonlyMap<number, string | null>
  tabWideAgentHintLeafId: string | null
}
/**
 * One worktree's complete mobile-snapshot input set.
 *
 * Why: every builder below takes this instead of `AppState`, so the compiler —
 * not a reviewer — proves what a worktree's snapshot actually depends on.
 */
export type MobileSessionWorktreeInputs = {
  worktreeId: string
  worktreeInstanceId: string | undefined
  terminalTabs: AppState['tabsByWorktree'][string]
  browserWorkspaces: AppState['browserTabsByWorktree'][string]
  unifiedTabs: AppState['unifiedTabsByWorktree'][string]
  groups: AppState['groupsByWorktree'][string]
  tabBarOrder: AppState['tabBarOrderByWorktree'][string] | undefined
  activeGroupId: string | null
  tabGroupLayout: TabGroupLayoutNode | undefined
  openFilesById: ReadonlyMap<string, AppState['openFiles'][number]> | undefined
  openFileIds: readonly string[]
  terminalLayoutByTabId: ReadonlyMap<string, AppState['terminalLayoutsByTabId'][string]>
  paneTitlesByTabId: ReadonlyMap<string, AppState['runtimePaneTitlesByTabId'][string]>
  launchDraftByPaneKey: ReadonlyMap<
    string,
    NonNullable<AppState['nativeChatLaunchDraftByTabId']>[string]
  >
  agentStatusByPaneKey: ReadonlyMap<string, AppState['agentStatusByPaneKey'][string]>
  editorDraftVersionByFileId: ReadonlyMap<string, string>
  pagesByBrowserWorkspaceId: ReadonlyMap<
    string,
    NonNullable<AppState['browserPagesByWorkspace']>[string]
  >
  certificateFailureByBrowserPageId: ReadonlyMap<
    string,
    NonNullable<AppState['browserCertificateFailuresByPageId']>[string]
  >
  activeEditorFileId: string | null
  activeEditorTabType: AppState['activeTabType'] | null
  activeTerminalTabId: string | null
  activeBrowserWorkspaceId: string | null
  generatedTitlesEnabled: boolean
  terminalTheme: RuntimeMobileTerminalTheme | undefined
  mountedSurfaceCaptureByTabId: ReadonlyMap<string, MountedTerminalSurfaceCapture>
}
