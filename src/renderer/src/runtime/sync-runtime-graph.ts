/* eslint-disable max-lines -- Why: runtime graph sync and mobile session-tab publication share the same injected renderer state and terminal registry. Keeping them together prevents a second store/registry reader from drifting. */
import {
  collectLeafIdsInOrder,
  serializePaneTree,
  normalizeTerminalLayoutSnapshot
} from '@/components/terminal-pane/layout-serialization'
import { warnTerminalLifecycleAnomaly } from '@/components/terminal-pane/terminal-lifecycle-diagnostics'
import { getEagerPtyBufferHandle } from '@/components/terminal-pane/pty-dispatcher'
import {
  collectParkedTerminalWatcherPtyIds,
  getParkedTerminalWatcherPaneIdsByPtyId
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'
import { getSystemPrefersDark, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileTerminalTheme,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeRendererSyncWindowGraph
} from '../../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { isClaudeManagementTitle } from '../../../shared/agent-detection'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import { resolveTerminalTabTitle } from '../../../shared/tab-title-resolution'
import {
  isNativeChatTabWideFallbackSafe,
  nativeChatLaunchAgentForLeaf,
  resolveNativeChatActiveLayoutLeafId
} from '../components/native-chat/native-chat-leaf-routing'
import {
  getActiveTabNavOrder,
  getGroupVisibleTabOrder,
  type VisibleTabRef
} from '../components/tab-bar/group-tab-order'
import { resolveTerminalLayoutRoot } from './remote-terminal-layout-resolution'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'
import { applyNativeChatLaunchDraftResolved } from './native-chat-launch-draft-runtime-resolution'

type RegisteredTerminalTab = {
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getContainer: () => HTMLDivElement | null
  getPtyIdForPane: (paneId: number) => string | null
  getTabWideAgentHintLeafId: () => string | null
}

type OpenFileByWorktreeAndId = Map<string, Map<string, AppState['openFiles'][number]>>
type OpenFileIndexes = {
  byWorktreeAndId: OpenFileByWorktreeAndId
  idsByWorktree: Map<string, string[]>
}
type FallbackEditorTabTarget = {
  tabId: string
  groupId: string | null
}
type TabsProjectionCacheEntry = {
  tabs: NonNullable<AppState['tabsByWorktree'][string]>
  worktreeIdJson: string
  projection: string
}
type TabsProjectionCache = {
  source: AppState['tabsByWorktree']
  entries: Map<string, TabsProjectionCacheEntry>
  projection: string
}
type AgentStatusProjectionCacheEntry = {
  entry: AppState['agentStatusByPaneKey'][string]
  projection: string
}
type AgentStatusProjectionCache = {
  source: AppState['agentStatusByPaneKey']
  entries: Map<string, AgentStatusProjectionCacheEntry>
  projection: string
}
type MobileSessionAgentStatusByWorktree = ReadonlyMap<
  string,
  ReadonlyMap<string, AppState['agentStatusByPaneKey'][string]>
>
/** Slices shared by every worktree in one publication; derived from `AppState` exactly once. */
type MobileSessionPublicationInputs = {
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
type MountedTerminalSurfaceCapture = {
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
type MobileSessionWorktreeInputs = {
  worktreeId: string
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

const registeredTabs = new Map<string, RegisteredTerminalTab>()
// Why: registration time suppresses the "no live transport" warning during the async PTY-connect window; after the grace period it's a real stuck state.
const tabRegisteredAt = new Map<string, number>()
const NO_TRANSPORT_GRACE_MS = 10_000
const EMPTY_ACTIVE_BROWSER_TAB_ID_BY_WORKTREE: AppState['activeBrowserTabIdByWorktree'] = {}
const EMPTY_BROWSER_TABS_BY_WORKTREE: AppState['browserTabsByWorktree'] = {}
const EMPTY_BROWSER_PAGES_BY_WORKSPACE: AppState['browserPagesByWorkspace'] = {}
const EMPTY_LAYOUT_BY_WORKTREE: AppState['layoutByWorktree'] = {}
const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS = 30_000
const RUNTIME_GRAPH_SYNC_COALESCE_MS = 16
let syncScheduled = false
let syncInFlight = false
let syncPendingAfterFlight = false
let syncEnabled = false
let syncTimer: ReturnType<typeof setTimeout> | null = null
let getStoreState: (() => AppState) | null = null
let mobileSessionSnapshotVersion = 0
// Why: main gates per-worktree mobile fanout on (publicationEpoch,
// snapshotVersion), so that pair must be a semantic revision: reuse the cached
// snapshot (same version) whenever a worktree's mobile-visible content is
// unchanged, and bump the version only for worktrees that actually changed.
const mobileSessionSnapshotCacheByWorktree = new Map<
  string,
  {
    inputs: MobileSessionWorktreeInputs
    content: unknown
    snapshot: RuntimeMobileSessionTabsSnapshot
  }
>()

// Structural equality under JSON-serialization semantics (undefined-valued
// keys are absent), so version reuse matches a JSON fingerprint exactly
// without allocating a serialized copy of the payload on every graph sync.
// Any value strict-equality can't prove equal (e.g. NaN) reads as changed,
// which only costs a redundant fanout — never a suppressed one.
function jsonContentEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((item, index) => jsonContentEquals(item, b[index]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  for (const key of Object.keys(aRecord)) {
    if (!jsonContentEquals(aRecord[key], bRecord[key])) {
      return false
    }
  }
  for (const key of Object.keys(bRecord)) {
    if (bRecord[key] !== undefined && aRecord[key] === undefined) {
      return false
    }
  }
  return true
}
let cachedTabsProjection: TabsProjectionCache | null = null
let cachedAgentStatusProjection: AgentStatusProjectionCache | null = null
let cachedOpenFileIndexesSource: AppState['openFiles'] | null = null
let cachedOpenFileIndexes: OpenFileIndexes | null = null
let cachedEditorDraftsSource: AppState['editorDrafts'] | null = null
let cachedEditorDraftVersionByFileId: Map<string, string> | null = null
let cachedMobileTerminalThemeSettings: AppState['settings'] | null = null
let cachedMobileTerminalThemeSystemPrefersDark: boolean | null = null
let cachedMobileTerminalTheme: RuntimeMobileTerminalTheme | undefined
let hasCachedMobileTerminalTheme = false
const EMPTY_NARROWED_BY_KEY: ReadonlyMap<string, never> = new Map<string, never>()
// Why: absent per-worktree slices must resolve to one shared value, or every empty
// worktree would present a fresh `[]` and never compare equal to its last publication.
const EMPTY_WORKTREE_TERMINAL_TABS: AppState['tabsByWorktree'][string] = []
const EMPTY_WORKTREE_BROWSER_WORKSPACES: AppState['browserTabsByWorktree'][string] = []
const EMPTY_WORKTREE_UNIFIED_TABS: AppState['unifiedTabsByWorktree'][string] = []
const EMPTY_WORKTREE_TAB_GROUPS: AppState['groupsByWorktree'][string] = []
const EMPTY_WORKTREE_OPEN_FILE_IDS: readonly string[] = []
const mobileSessionPublicationEpoch = `renderer:${createBrowserUuid()}`
// Why: the snapshot object main last acknowledged per worktree; anything still
// identical is withheld from the graph payload instead of re-cloned across IPC.
const publishedMobileSessionSnapshotByWorktree = new Map<string, RuntimeMobileSessionTabsSnapshot>()

export function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void {
  getStoreState = getter
}

/** True while a TerminalPane for this tab is mounted (lifecycle effect ran). */
export function hasRegisteredRuntimeTerminalTab(tabId: string): boolean {
  return registeredTabs.has(tabId)
}

export function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void {
  registeredTabs.set(tab.tabId, tab)
  tabRegisteredAt.set(tab.tabId, Date.now())
  scheduleRuntimeGraphSync()
  return () => {
    // Why: React can mount a replacement surface before the prior effect cleans up; stale cleanup must not erase the successor's registry.
    if (registeredTabs.get(tab.tabId) !== tab) {
      return
    }
    registeredTabs.delete(tab.tabId)
    tabRegisteredAt.delete(tab.tabId)
    scheduleRuntimeGraphSync()
  }
}

export function focusRuntimeTerminalSurface(tabId: string, leafId?: string | null): boolean {
  const registered = registeredTabs.get(tabId)
  const manager = registered?.getManager()
  if (!manager) {
    return false
  }
  if (!leafId) {
    manager.getActivePane()?.terminal.focus()
    return true
  }
  const resolution = resolveLeafIdForManager(tabId, leafId, manager)
  if (resolution.status !== 'resolved') {
    return false
  }
  manager.setActivePane(resolution.numericPaneId, { focus: true })
  scheduleRuntimeGraphSync()
  return true
}

export function setRuntimeGraphSyncEnabled(enabled: boolean): void {
  syncEnabled = enabled
  if (!enabled) {
    syncPendingAfterFlight = false
    clearScheduledRuntimeGraphSync()
    return
  }
  scheduleRuntimeGraphSync()
}

function clearScheduledRuntimeGraphSync(): void {
  if (syncTimer !== null) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
  syncScheduled = false
}

export function scheduleRuntimeGraphSync(): void {
  if (!syncEnabled || syncScheduled) {
    return
  }
  if (syncInFlight) {
    syncPendingAfterFlight = true
    return
  }
  syncScheduled = true
  // Why: a frame-sized timer collapses separate title/status IPC tasks into one graph publish without tying publication to paint frames.
  syncTimer = setTimeout(() => {
    syncTimer = null
    syncScheduled = false
    void runRuntimeGraphSync()
  }, RUNTIME_GRAPH_SYNC_COALESCE_MS)
}

async function runRuntimeGraphSync(): Promise<void> {
  if (syncInFlight) {
    syncPendingAfterFlight = true
    return
  }
  syncInFlight = true
  try {
    await syncRuntimeGraph()
  } finally {
    syncInFlight = false
    if (syncPendingAfterFlight) {
      syncPendingAfterFlight = false
      // Why: coalesce updates that arrived during one in-flight sync into a single trailing graph instead of stacking concurrent IPC calls.
      scheduleRuntimeGraphSync()
    }
  }
}

export type RuntimeMobileSessionSyncKey = {
  // Why: reference changes signal layout/title updates without stringifying thousands of tabs.
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
  // Why: underlying refs churn even when the mobile shape is unchanged (tabsByWorktree reallocates per OSC title frame); pre-serialize.
  tabsProjection: string
  openFilesProjection: string
  browserProjection: string
  editorDraftsProjection: string
}

export function canSkipRuntimeMobileSessionSyncKeyBuild(
  state: AppState,
  previousState: AppState,
  systemPrefersDark?: boolean,
  previousSystemPrefersDark: boolean | null | undefined = systemPrefersDark
): boolean {
  const terminalThemeSystemPrefersDark = getTerminalThemeSystemPrefersDark(state, systemPrefersDark)
  const previousTerminalThemeSystemPrefersDark = getTerminalThemeSystemPrefersDark(
    previousState,
    previousSystemPrefersDark
  )
  return (
    terminalThemeSystemPrefersDark === previousTerminalThemeSystemPrefersDark &&
    state.tabsByWorktree === previousState.tabsByWorktree &&
    state.groupsByWorktree === previousState.groupsByWorktree &&
    state.activeGroupIdByWorktree === previousState.activeGroupIdByWorktree &&
    state.layoutByWorktree === previousState.layoutByWorktree &&
    state.unifiedTabsByWorktree === previousState.unifiedTabsByWorktree &&
    state.tabBarOrderByWorktree === previousState.tabBarOrderByWorktree &&
    state.activeFileId === previousState.activeFileId &&
    state.activeFileIdByWorktree === previousState.activeFileIdByWorktree &&
    state.activeTabType === previousState.activeTabType &&
    state.activeTabTypeByWorktree === previousState.activeTabTypeByWorktree &&
    state.browserTabsByWorktree === previousState.browserTabsByWorktree &&
    state.browserPagesByWorkspace === previousState.browserPagesByWorkspace &&
    state.activeBrowserTabIdByWorktree === previousState.activeBrowserTabIdByWorktree &&
    state.openFiles === previousState.openFiles &&
    state.editorDrafts === previousState.editorDrafts &&
    state.settings === previousState.settings &&
    state.activeTabId === previousState.activeTabId &&
    state.terminalLayoutsByTabId === previousState.terminalLayoutsByTabId &&
    state.runtimePaneTitlesByTabId === previousState.runtimePaneTitlesByTabId &&
    state.nativeChatLaunchDraftByTabId === previousState.nativeChatLaunchDraftByTabId &&
    state.folderWorkspaces === previousState.folderWorkspaces &&
    state.agentStatusEpoch === previousState.agentStatusEpoch &&
    state.agentStatusByPaneKey === previousState.agentStatusByPaneKey
  )
}

function getTerminalThemeSystemPrefersDark(
  state: Pick<AppState, 'settings'>,
  systemPrefersDark: boolean | null | undefined
): boolean | null {
  return state.settings?.theme === 'system' ? (systemPrefersDark ?? null) : null
}

export function getRuntimeMobileSessionSyncKey(
  state: AppState,
  previousState?: AppState,
  previousKey?: RuntimeMobileSessionSyncKey,
  systemPrefersDark = getSystemPrefersDark()
): RuntimeMobileSessionSyncKey {
  const canReusePrevious = previousState !== undefined && previousKey !== undefined
  const terminalThemeSystemPrefersDark = getTerminalThemeSystemPrefersDark(state, systemPrefersDark)
  const browserTabsByWorktree = getBrowserTabsByWorktree(state)
  const browserPagesByWorkspace = getBrowserPagesByWorkspace(state)
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS_BY_PANE_KEY
  const previousBrowserTabsByWorktree = previousState
    ? getBrowserTabsByWorktree(previousState)
    : EMPTY_BROWSER_TABS_BY_WORKTREE
  const previousBrowserPagesByWorkspace = previousState
    ? getBrowserPagesByWorkspace(previousState)
    : EMPTY_BROWSER_PAGES_BY_WORKSPACE
  const previousAgentStatusByPaneKey = previousState
    ? (previousState.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS_BY_PANE_KEY)
    : EMPTY_AGENT_STATUS_BY_PANE_KEY

  return {
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    nativeChatLaunchDraftByTabId: state.nativeChatLaunchDraftByTabId,
    folderWorkspaces: state.folderWorkspaces,
    groupsByWorktree: state.groupsByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    layoutByWorktree: state.layoutByWorktree ?? EMPTY_LAYOUT_BY_WORKTREE,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabBarOrderByWorktree: state.tabBarOrderByWorktree,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeTabType: state.activeTabType,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree,
    activeTabId: state.activeTabId,
    activeBrowserTabIdByWorktree:
      state.activeBrowserTabIdByWorktree ?? EMPTY_ACTIVE_BROWSER_TAB_ID_BY_WORKTREE,
    // Why: epoch covers sort/retention/freshness changes; projection covers prompt/tool details, skipping timestamp-only heartbeats.
    agentStatusEpoch: state.agentStatusEpoch ?? 0,
    agentStatusProjection:
      canReusePrevious && agentStatusByPaneKey === previousAgentStatusByPaneKey
        ? previousKey.agentStatusProjection
        : buildRuntimeMobileAgentStatusProjection(agentStatusByPaneKey),
    generatedTabTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
    systemPrefersDark: terminalThemeSystemPrefersDark,
    terminalThemeProjection:
      canReusePrevious &&
      state.settings === previousState.settings &&
      previousKey.systemPrefersDark === terminalThemeSystemPrefersDark
        ? previousKey.terminalThemeProjection
        : JSON.stringify(resolveMobileTerminalTheme(state, systemPrefersDark) ?? null),
    // Why: background title ticks churn many times/sec; reuse unchanged projections so they don't rescan all tabs, files, and drafts.
    tabsProjection:
      canReusePrevious && state.tabsByWorktree === previousState.tabsByWorktree
        ? previousKey.tabsProjection
        : buildRuntimeMobileTabsProjection(state.tabsByWorktree),
    openFilesProjection:
      canReusePrevious && state.openFiles === previousState.openFiles
        ? previousKey.openFilesProjection
        : buildRuntimeMobileOpenFilesProjection(state.openFiles),
    browserProjection:
      canReusePrevious &&
      browserTabsByWorktree === previousBrowserTabsByWorktree &&
      browserPagesByWorkspace === previousBrowserPagesByWorkspace
        ? previousKey.browserProjection
        : buildRuntimeMobileBrowserProjection(state),
    editorDraftsProjection:
      canReusePrevious && state.editorDrafts === previousState.editorDrafts
        ? previousKey.editorDraftsProjection
        : buildRuntimeMobileEditorDraftsProjection(state.editorDrafts)
  }
}

function getBrowserTabsByWorktree(state: AppState): AppState['browserTabsByWorktree'] {
  // Why: some callers/tests build partial pre-browser states; treat missing browser slices as no tabs.
  return state.browserTabsByWorktree ?? EMPTY_BROWSER_TABS_BY_WORKTREE
}

function getBrowserPagesByWorkspace(state: AppState): AppState['browserPagesByWorkspace'] {
  return state.browserPagesByWorkspace ?? EMPTY_BROWSER_PAGES_BY_WORKSPACE
}

function buildRuntimeMobileTabsProjection(tabsByWorktree: AppState['tabsByWorktree']): string {
  if (cachedTabsProjection?.source === tabsByWorktree) {
    return cachedTabsProjection.projection
  }

  const previousEntries = cachedTabsProjection?.entries
  const entries = new Map<string, TabsProjectionCacheEntry>()
  const parts: string[] = []

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const previous = previousEntries?.get(worktreeId)
    const entry =
      previous?.tabs === tabs
        ? previous
        : {
            tabs,
            worktreeIdJson: previous?.worktreeIdJson ?? JSON.stringify(worktreeId),
            projection: JSON.stringify(
              tabs.map((tab) => ({
                id: tab.id,
                title: tab.title,
                quickCommandLabel: tab.quickCommandLabel,
                aiVaultTitle: tab.aiVaultTitle,
                generatedTitle: tab.generatedTitle,
                customTitle: tab.customTitle,
                launchAgent: tab.launchAgent
              }))
            )
          }
    entries.set(worktreeId, entry)
    parts.push(`${entry.worktreeIdJson}:${entry.projection}`)
  }

  cachedTabsProjection = {
    source: tabsByWorktree,
    entries,
    projection: `{${parts.join(',')}}`
  }
  return cachedTabsProjection.projection
}

function resolveRuntimeTerminalTitle(
  tab: Pick<
    TerminalTab,
    'customTitle' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedTitle' | 'title'
  >,
  generatedTitlesEnabled: boolean,
  liveTitle = tab.title
): string {
  return resolveTerminalTabTitle({ ...tab, title: liveTitle }, generatedTitlesEnabled, liveTitle)
}

function buildRuntimeMobileOpenFilesProjection(openFiles: AppState['openFiles']): string {
  return JSON.stringify(
    openFiles.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      mode: file.mode,
      diffSource: file.diffSource,
      isDirty: file.isDirty,
      isUntitled: file.isUntitled,
      deleteUntouchedOnClose: file.deleteUntouchedOnClose,
      markdownPreviewSourceFileId: file.markdownPreviewSourceFileId
    }))
  )
}

function buildRuntimeMobileBrowserProjection(state: AppState): string {
  const browserTabsByWorktree = getBrowserTabsByWorktree(state)
  const browserPagesByWorkspace = getBrowserPagesByWorkspace(state)
  return JSON.stringify({
    workspacesByWorktree: Object.fromEntries(
      Object.entries(browserTabsByWorktree).map(([worktreeId, workspaces]) => [
        worktreeId,
        workspaces.map((workspace) => ({
          id: workspace.id,
          activePageId: workspace.activePageId,
          title: workspace.title,
          url: workspace.url,
          loading: workspace.loading,
          canGoBack: workspace.canGoBack,
          canGoForward: workspace.canGoForward
        }))
      ])
    ),
    pagesByWorkspace: Object.fromEntries(
      Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
        workspaceId,
        pages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          loading: page.loading,
          canGoBack: page.canGoBack,
          canGoForward: page.canGoForward
        }))
      ])
    )
  })
}

function buildRuntimeMobileEditorDraftsProjection(editorDrafts: AppState['editorDrafts']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(editorDrafts).map(([fileId, content]) => [fileId, stableHashString(content)])
    )
  )
}

function serializeRuntimeMobileAgentStatusEntry(
  paneKey: string,
  entry: AppState['agentStatusByPaneKey'][string]
): string {
  return JSON.stringify({
    paneKey,
    entryPaneKey: entry.paneKey,
    state: entry.state,
    workingMode: entry.workingMode ?? null,
    prompt: entry.prompt,
    updatedAtBucket: Math.floor(entry.updatedAt / AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS),
    stateStartedAt: entry.stateStartedAt,
    agentType: entry.agentType ?? null,
    terminalTitle: entry.terminalTitle ?? null,
    stateHistory: entry.stateHistory.map((history) => ({
      state: history.state,
      prompt: history.prompt,
      startedAt: history.startedAt,
      interrupted: history.interrupted ?? null
    })),
    toolName: entry.toolName ?? null,
    toolInput: entry.toolInput ?? null,
    // Why: include so a newly-captured AskUserQuestion prompt re-fires the mobile republish even when no other field changed.
    interactivePrompt: entry.interactivePrompt ?? null,
    lastAssistantMessage: entry.lastAssistantMessage ?? null,
    interrupted: entry.interrupted ?? null
  })
}

function buildRuntimeMobileAgentStatusProjection(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): string {
  if (cachedAgentStatusProjection?.source === agentStatusByPaneKey) {
    return cachedAgentStatusProjection.projection
  }

  // Why per-entry: a status ping replaces one entry and re-spreads the map, so
  // without this every other live agent — each carrying a 20-entry history and an
  // 8 KB message — is re-serialized to discover it did not change.
  const previousEntries = cachedAgentStatusProjection?.entries
  const entries = new Map<string, AgentStatusProjectionCacheEntry>()
  const parts: string[] = []

  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const previous = previousEntries?.get(paneKey)
    const cached =
      previous?.entry === entry
        ? previous
        : { entry, projection: serializeRuntimeMobileAgentStatusEntry(paneKey, entry) }
    entries.set(paneKey, cached)
    parts.push(cached.projection)
  }

  const projection = `[${parts.join(',')}]`
  cachedAgentStatusProjection = { source: agentStatusByPaneKey, entries, projection }
  return projection
}

export function buildRuntimeMobileAgentStatusProjectionForTests(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): string {
  return buildRuntimeMobileAgentStatusProjection(agentStatusByPaneKey)
}

export const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS =
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS

export function resetRuntimeMobileAgentStatusProjectionCacheForTests(): void {
  cachedAgentStatusProjection = null
}

export function runtimeMobileSessionSyncKeysEqual(
  a: RuntimeMobileSessionSyncKey,
  b: RuntimeMobileSessionSyncKey
): boolean {
  return (
    a.terminalLayoutsByTabId === b.terminalLayoutsByTabId &&
    a.runtimePaneTitlesByTabId === b.runtimePaneTitlesByTabId &&
    a.nativeChatLaunchDraftByTabId === b.nativeChatLaunchDraftByTabId &&
    a.folderWorkspaces === b.folderWorkspaces &&
    a.groupsByWorktree === b.groupsByWorktree &&
    a.activeGroupIdByWorktree === b.activeGroupIdByWorktree &&
    a.layoutByWorktree === b.layoutByWorktree &&
    a.unifiedTabsByWorktree === b.unifiedTabsByWorktree &&
    a.tabBarOrderByWorktree === b.tabBarOrderByWorktree &&
    a.activeFileId === b.activeFileId &&
    a.activeFileIdByWorktree === b.activeFileIdByWorktree &&
    a.activeTabType === b.activeTabType &&
    a.activeTabTypeByWorktree === b.activeTabTypeByWorktree &&
    a.activeTabId === b.activeTabId &&
    a.activeBrowserTabIdByWorktree === b.activeBrowserTabIdByWorktree &&
    a.agentStatusEpoch === b.agentStatusEpoch &&
    a.agentStatusProjection === b.agentStatusProjection &&
    a.generatedTabTitlesEnabled === b.generatedTabTitlesEnabled &&
    a.systemPrefersDark === b.systemPrefersDark &&
    a.terminalThemeProjection === b.terminalThemeProjection &&
    a.tabsProjection === b.tabsProjection &&
    a.openFilesProjection === b.openFilesProjection &&
    a.browserProjection === b.browserProjection &&
    a.editorDraftsProjection === b.editorDraftsProjection
  )
}

async function syncRuntimeGraph(): Promise<void> {
  if (!syncEnabled || !getStoreState) {
    return
  }
  // Why: can't import the store directly (terminal slice imports this module); inject the getter to break the construction cycle.
  const state = getStoreState()
  const systemPrefersDark = getSystemPrefersDark()
  // Why: build lookup maps once per sync instead of re-flattening every worktree's tabs for each registered terminal.
  const terminalTabById = new Map(
    Object.values(state.tabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab])
  )
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const mobileSessionTabs = buildMobileSessionTabSnapshots(state, systemPrefersDark)
  const publication = partitionMobileSessionPublication(mobileSessionTabs)
  const graph: RuntimeRendererSyncWindowGraph = {
    tabs: [],
    leaves: [],
    rendererGeneration: mobileSessionPublicationEpoch,
    mobileSessionTabs: publication.changed,
    unchangedMobileSessionWorktrees: publication.unchangedWorktrees
  }

  for (const [tabId, registeredTab] of registeredTabs) {
    const tab = terminalTabById.get(tabId)
    if (!tab) {
      continue
    }
    if (isWebOnlyMirroredTerminalTab(tab, state.terminalLayoutsByTabId[tabId])) {
      continue
    }

    const manager = registeredTab.getManager()
    const container = registeredTab.getContainer()
    const activePaneId = manager?.getActivePane()?.id ?? null
    const root =
      container?.firstElementChild instanceof HTMLElement ? container.firstElementChild : null

    graph.tabs.push({
      tabId,
      worktreeId: registeredTab.worktreeId,
      title: resolveRuntimeTerminalTitle(tab, generatedTitlesEnabled),
      activeLeafId: activePaneId === null ? null : (manager?.getLeafId(activePaneId) ?? null),
      layout: serializePaneTree(root)
    })

    const savedPtyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
    for (const pane of manager?.getPanes() ?? []) {
      const leafId = pane.leafId
      const ptyId = registeredTab.getPtyIdForPane(pane.id)
      const savedPtyId = savedPtyIdsByLeafId[leafId] ?? null
      const registeredTime = tabRegisteredAt.get(tabId) ?? 0
      if (!ptyId && savedPtyId && Date.now() - registeredTime > NO_TRANSPORT_GRACE_MS) {
        warnTerminalLifecycleAnomaly('mounted terminal leaf has saved PTY but no live transport', {
          tabId,
          worktreeId: registeredTab.worktreeId,
          leafId,
          paneId: pane.id,
          ptyId: savedPtyId
        })
      }
      const paneTitles = state.runtimePaneTitlesByTabId[tabId] ?? {}
      graph.leaves.push({
        tabId,
        worktreeId: registeredTab.worktreeId,
        leafId,
        paneRuntimeId: pane.id,
        ptyId,
        paneTitle: paneTitles[pane.id] ?? null,
        title: resolveRuntimeTerminalTitle(
          tab,
          generatedTitlesEnabled,
          state.runtimePaneTitlesByTabId[tabId]?.[pane.id] ?? tab.title
        )
      })
    }
  }

  // Why: inactive automation tabs never mount a TerminalPane; publish their leaf+ptyId from persisted layout (gated on a live buffer) or the live PTY looks orphaned.
  // Cold-parked tabs are the same shape with a different liveness proof: their
  // pane is unmounted but a parked watcher still owns the PTY. Dropping their
  // leaf invalidates the terminal handle every paired subscriber is bound to,
  // stalling a remotely-driven terminal the host merely stopped displaying.
  // Built once for the whole publication; a per-leaf registry scan would be
  // quadratic across a many-worktree workspace.
  const parkedWatcherPtyIds = collectParkedTerminalWatcherPtyIds()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = state.terminalLayoutsByTabId[tab.id]
      if (registeredTabs.has(tab.id) || isWebOnlyMirroredTerminalTab(tab, layout)) {
        continue
      }
      const savedPtyIdsByLeafId = layout?.ptyIdsByLeafId
      if (!savedPtyIdsByLeafId) {
        continue
      }
      const liveLeaves = Object.entries(savedPtyIdsByLeafId).filter(
        ([leafId, ptyId]) =>
          typeof ptyId === 'string' &&
          ptyId.length > 0 &&
          isTerminalLeafId(leafId) &&
          (Boolean(getEagerPtyBufferHandle(ptyId)) || parkedWatcherPtyIds.has(ptyId))
      )
      if (liveLeaves.length === 0) {
        continue
      }
      const title = resolveRuntimeTerminalTitle(tab, generatedTitlesEnabled)
      // Why: partial coverage is legitimate — one leaf's watcher can be disposed
      // while its siblings stay parked — so a saved activeLeafId that did not
      // survive the filter would name a leaf this publication never sends.
      const publishedLeafIds = new Set(liveLeaves.map(([leafId]) => leafId))
      const savedActiveLeafId = layout?.activeLeafId
      const parkedPaneIdsByPtyId = getParkedTerminalWatcherPaneIdsByPtyId(tab.id)
      const parkedPaneTitles = state.runtimePaneTitlesByTabId[tab.id] ?? {}
      graph.tabs.push({
        tabId: tab.id,
        worktreeId,
        title,
        activeLeafId:
          savedActiveLeafId && publishedLeafIds.has(savedActiveLeafId)
            ? savedActiveLeafId
            : liveLeaves[0][0],
        layout: resolveTerminalLayoutRoot({
          authoritativeRoot: layout?.root,
          leafIds: liveLeaves.map(([leafId]) => leafId),
          onSynthesize: (leafCount) =>
            console.warn(
              `[sync-runtime-graph] synthesized layout for ${leafCount} unmounted leaves with no saved tree`
            )
        })
      })
      liveLeaves.forEach(([leafId, ptyId], index) => {
        // Why the watcher's id wins: PaneManager ids are allocated monotonically
        // and closing a pane retires its id without renumbering, so an ordinal
        // can name a pane that no longer exists — and main routes split/close and
        // the paneKey fallback through this value.
        const parkedPaneId = parkedPaneIdsByPtyId.get(ptyId)
        graph.leaves.push({
          tabId: tab.id,
          worktreeId,
          leafId,
          paneRuntimeId: parkedPaneId ?? index + 1,
          ptyId,
          // Why not null: the parked byte watcher keeps writing this pane's
          // runtime title, and main prefers leaf.paneTitle over its own older
          // lastOscTitle. Dropping it would pin a parked agent pane to a stale
          // title for as long as it stays parked.
          paneTitle: (parkedPaneId === undefined ? null : parkedPaneTitles[parkedPaneId]) ?? null,
          title
        })
      })
    }
  }

  try {
    const result = await window.api.runtime.syncWindowGraph(graph)
    // Why: only an acknowledged publication may be treated as delivered. A throw
    // leaves the memo behind, so the retry resends every worktree in full.
    commitMobileSessionPublication(mobileSessionTabs, result?.mobileSessionResyncWorktrees)
    const currentState = getStoreState()
    currentState?.setRuntimeAgentOrchestrationByPaneKey?.(result?.agentOrchestrationByPaneKey ?? {})
    for (const resolution of result?.nativeChatLaunchDraftResolutions ?? []) {
      if (currentState) {
        applyNativeChatLaunchDraftResolved(currentState, {
          type: 'nativeChatLaunchDraftResolved',
          ...resolution
        })
      }
    }
    if (result?.mobileSessionResyncWorktrees?.length) {
      scheduleRuntimeGraphSync()
    }
  } catch (error) {
    console.error('[runtime] Failed to sync renderer graph:', error)
  }
}

function partitionMobileSessionPublication(snapshots: RuntimeMobileSessionTabsSnapshot[]): {
  changed: RuntimeMobileSessionTabsSnapshot[]
  unchangedWorktrees: string[]
} {
  const changed: RuntimeMobileSessionTabsSnapshot[] = []
  const unchangedWorktrees: string[] = []
  for (const snapshot of snapshots) {
    // Why: buildMobileSessionTabSnapshots returns the cached object for a worktree
    // it did not rebuild, so identity — not a deep compare — settles this.
    if (publishedMobileSessionSnapshotByWorktree.get(snapshot.worktree) === snapshot) {
      unchangedWorktrees.push(snapshot.worktree)
    } else {
      changed.push(snapshot)
    }
  }
  return { changed, unchangedWorktrees }
}

function commitMobileSessionPublication(
  snapshots: RuntimeMobileSessionTabsSnapshot[],
  resyncWorktrees: string[] | undefined
): void {
  const published = new Set<string>()
  for (const snapshot of snapshots) {
    published.add(snapshot.worktree)
    publishedMobileSessionSnapshotByWorktree.set(snapshot.worktree, snapshot)
  }
  for (const worktreeId of publishedMobileSessionSnapshotByWorktree.keys()) {
    if (!published.has(worktreeId)) {
      publishedMobileSessionSnapshotByWorktree.delete(worktreeId)
    }
  }
  // Why: main dropped these after acknowledging them, so forget the delivery and
  // let the scheduled resync republish them in full.
  for (const worktreeId of resyncWorktrees ?? []) {
    publishedMobileSessionSnapshotByWorktree.delete(worktreeId)
  }
}

function narrowRecordByKeys<T>(
  source: Record<string, T> | undefined,
  keys: readonly string[]
): ReadonlyMap<string, T> {
  if (!source || keys.length === 0) {
    return EMPTY_NARROWED_BY_KEY
  }
  let narrowed: Map<string, T> | null = null
  for (const key of keys) {
    const value = source[key]
    if (value === undefined) {
      continue
    }
    narrowed ??= new Map<string, T>()
    narrowed.set(key, value)
  }
  return narrowed ?? EMPTY_NARROWED_BY_KEY
}

function narrowMapByKeys<T>(
  source: ReadonlyMap<string, T>,
  keys: readonly string[]
): ReadonlyMap<string, T> {
  if (source.size === 0 || keys.length === 0) {
    return EMPTY_NARROWED_BY_KEY
  }
  let narrowed: Map<string, T> | null = null
  for (const key of keys) {
    if (!source.has(key)) {
      continue
    }
    narrowed ??= new Map<string, T>()
    narrowed.set(key, source.get(key) as T)
  }
  return narrowed ?? EMPTY_NARROWED_BY_KEY
}

function getMobileTerminalTheme(
  state: AppState,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  // Why: resolving per terminal tab allocated a fresh theme per surface; one instance per publication is byte-identical downstream.
  if (
    hasCachedMobileTerminalTheme &&
    cachedMobileTerminalThemeSettings === state.settings &&
    cachedMobileTerminalThemeSystemPrefersDark === systemPrefersDark
  ) {
    return cachedMobileTerminalTheme
  }
  cachedMobileTerminalTheme = resolveMobileTerminalTheme(state, systemPrefersDark)
  cachedMobileTerminalThemeSettings = state.settings
  cachedMobileTerminalThemeSystemPrefersDark = systemPrefersDark
  hasCachedMobileTerminalTheme = true
  return cachedMobileTerminalTheme
}

function buildMobileSessionAgentStatusByWorktree(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'],
  tabsByWorktree: AppState['tabsByWorktree']
): MobileSessionAgentStatusByWorktree {
  const byWorktreeId = new Map<string, Map<string, AppState['agentStatusByPaneKey'][string]>>()
  const paneKeys = Object.keys(agentStatusByPaneKey)
  if (paneKeys.length === 0) {
    return byWorktreeId
  }
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }
  for (const paneKey of paneKeys) {
    // Why: every key a builder can look up is makePaneKey output, so an unparseable key is unreachable state, not a missed input.
    const tabId = parsePaneKey(paneKey)?.tabId
    const worktreeId = tabId === undefined ? undefined : worktreeIdByTabId.get(tabId)
    if (worktreeId === undefined) {
      continue
    }
    let bucket = byWorktreeId.get(worktreeId)
    if (!bucket) {
      bucket = new Map()
      byWorktreeId.set(worktreeId, bucket)
    }
    bucket.set(paneKey, agentStatusByPaneKey[paneKey])
  }
  return byWorktreeId
}

function buildMobileSessionWorktreeInputs(
  state: AppState,
  worktreeId: string,
  publication: MobileSessionPublicationInputs
): MobileSessionWorktreeInputs {
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_TERMINAL_TABS
  const terminalTabIds = terminalTabs.map((tab) => tab.id)
  const terminalLayoutByTabId = narrowRecordByKeys(state.terminalLayoutsByTabId, terminalTabIds)
  const mountedSurfaceCaptureByTabId = captureMountedTerminalSurfaces(
    terminalTabs,
    state.terminalLayoutsByTabId
  )
  const browserWorkspaces =
    publication.browserTabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_BROWSER_WORKSPACES
  const pagesByBrowserWorkspaceId = narrowRecordByKeys(
    state.browserPagesByWorkspace,
    browserWorkspaces.map((workspace) => workspace.id)
  )
  const browserPageIds: string[] = []
  for (const pages of pagesByBrowserWorkspaceId.values()) {
    for (const page of pages) {
      browserPageIds.push(page.id)
    }
  }
  const openFilesById = publication.openFileIndexes.byWorktreeAndId.get(worktreeId)
  const openFileIds =
    publication.openFileIndexes.idsByWorktree.get(worktreeId) ?? EMPTY_WORKTREE_OPEN_FILE_IDS
  // Why: the global activeFileId/activeTabType fallbacks only matter when the active file lives here, so resolve them per worktree.
  const resolvedActiveFileId = state.activeFileIdByWorktree?.[worktreeId] ?? state.activeFileId
  const activeEditorFileId =
    resolvedActiveFileId && openFilesById?.has(resolvedActiveFileId) ? resolvedActiveFileId : null
  const activeTabId = state.activeTabId
  return {
    worktreeId,
    terminalTabs,
    browserWorkspaces,
    unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_UNIFIED_TABS,
    groups: state.groupsByWorktree[worktreeId] ?? EMPTY_WORKTREE_TAB_GROUPS,
    tabBarOrder: state.tabBarOrderByWorktree[worktreeId],
    activeGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
    tabGroupLayout: (state.layoutByWorktree ?? EMPTY_LAYOUT_BY_WORKTREE)[worktreeId],
    openFilesById,
    openFileIds,
    terminalLayoutByTabId,
    paneTitlesByTabId: narrowRecordByKeys(state.runtimePaneTitlesByTabId, terminalTabIds),
    launchDraftByPaneKey: buildMobileLaunchDraftsByPaneKey({
      terminalTabs,
      terminalLayoutByTabId,
      mountedSurfaceCaptureByTabId,
      launchDraftByTabId: narrowRecordByKeys(state.nativeChatLaunchDraftByTabId, terminalTabIds)
    }),
    agentStatusByPaneKey:
      publication.agentStatusByWorktreeId.get(worktreeId) ?? EMPTY_NARROWED_BY_KEY,
    editorDraftVersionByFileId: narrowMapByKeys(
      publication.editorDraftVersionByFileId,
      openFileIds
    ),
    pagesByBrowserWorkspaceId,
    certificateFailureByBrowserPageId: narrowRecordByKeys(
      state.browserCertificateFailuresByPageId,
      browserPageIds
    ),
    activeEditorFileId,
    activeEditorTabType: activeEditorFileId
      ? (state.activeTabTypeByWorktree?.[worktreeId] ?? state.activeTabType)
      : null,
    activeTerminalTabId:
      activeTabId !== null && terminalTabIds.includes(activeTabId) ? activeTabId : null,
    activeBrowserWorkspaceId: state.activeBrowserTabIdByWorktree?.[worktreeId] ?? null,
    generatedTitlesEnabled: publication.generatedTitlesEnabled,
    terminalTheme: publication.terminalTheme,
    mountedSurfaceCaptureByTabId
  }
}

function captureMountedTerminalSurfaces(
  terminalTabs: AppState['tabsByWorktree'][string],
  terminalLayoutsByTabId: AppState['terminalLayoutsByTabId']
): ReadonlyMap<string, MountedTerminalSurfaceCapture> {
  let captures: Map<string, MountedTerminalSurfaceCapture> | null = null
  for (const tab of terminalTabs) {
    const registered = registeredTabs.get(tab.id)
    if (!registered) {
      continue
    }
    captures ??= new Map()
    captures.set(tab.id, captureMountedTerminalSurface(registered, terminalLayoutsByTabId[tab.id]))
  }
  return captures ?? EMPTY_NARROWED_BY_KEY
}

function captureMountedTerminalSurface(
  registered: RegisteredTerminalTab,
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): MountedTerminalSurfaceCapture {
  const manager = registered.getManager()
  const paneLeafIds = manager?.getPanes().map((pane) => pane.leafId) ?? []
  const activePane = manager?.getActivePane() ?? null
  const firstChild = registered.getContainer()?.firstElementChild
  // Why: mirrors getRuntimeLeafIdsForTerminal so every leaf the builder resolves has a captured pane id.
  const effectiveLeafIds =
    paneLeafIds.length > 0
      ? paneLeafIds
      : collectLeafIdsInOrder(savedLayout?.root).filter(isTerminalLeafId)
  const numericPaneIdByLeafId = new Map<string, number | null>()
  const ptyIdByNumericPaneId = new Map<number, string | null>()
  for (const leafId of effectiveLeafIds) {
    const numericPaneId = manager?.getNumericIdForLeaf(leafId) ?? null
    numericPaneIdByLeafId.set(leafId, numericPaneId)
    if (numericPaneId !== null) {
      ptyIdByNumericPaneId.set(numericPaneId, registered.getPtyIdForPane(numericPaneId))
    }
  }
  return {
    paneLeafIds,
    hasLiveActivePane: activePane !== null,
    liveActiveLeafId: activePane !== null ? (manager?.getLeafId(activePane.id) ?? null) : null,
    liveLayoutRoot: serializePaneTree(
      typeof HTMLElement !== 'undefined' && firstChild instanceof HTMLElement ? firstChild : null
    ),
    numericPaneIdByLeafId,
    ptyIdByNumericPaneId,
    tabWideAgentHintLeafId: registered.getTabWideAgentHintLeafId()
  }
}

function mountedTerminalSurfaceCaptureEquals(
  a: MountedTerminalSurfaceCapture,
  b: MountedTerminalSurfaceCapture
): boolean {
  return (
    a.hasLiveActivePane === b.hasLiveActivePane &&
    a.liveActiveLeafId === b.liveActiveLeafId &&
    a.paneLeafIds.length === b.paneLeafIds.length &&
    a.paneLeafIds.every((leafId, index) => b.paneLeafIds[index] === leafId) &&
    narrowedEntriesEqual(a.numericPaneIdByLeafId, b.numericPaneIdByLeafId) &&
    narrowedEntriesEqual(a.ptyIdByNumericPaneId, b.ptyIdByNumericPaneId) &&
    a.tabWideAgentHintLeafId === b.tabWideAgentHintLeafId &&
    // Why: serialization allocates a fresh tree per capture, so it compares by content.
    jsonContentEquals(a.liveLayoutRoot, b.liveLayoutRoot)
  )
}

function mountedSurfaceCapturesEqual(
  a: ReadonlyMap<string, MountedTerminalSurfaceCapture>,
  b: ReadonlyMap<string, MountedTerminalSurfaceCapture>
): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const [tabId, capture] of a) {
    const other = b.get(tabId)
    if (!other || !mountedTerminalSurfaceCaptureEquals(capture, other)) {
      return false
    }
  }
  return true
}

function narrowedEntriesEqual<K, T>(a: ReadonlyMap<K, T>, b: ReadonlyMap<K, T>): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false
    }
  }
  return true
}

/**
 * True when a worktree's snapshot can be reused without rebuilding its content.
 *
 * Every field of `MobileSessionWorktreeInputs` is compared, so a missed input
 * is a compile error rather than a stale publication to paired clients.
 */
function canReuseMobileSessionSnapshot(
  previous: MobileSessionWorktreeInputs,
  next: MobileSessionWorktreeInputs
): boolean {
  return (
    previous.worktreeId === next.worktreeId &&
    previous.terminalTabs === next.terminalTabs &&
    previous.browserWorkspaces === next.browserWorkspaces &&
    previous.unifiedTabs === next.unifiedTabs &&
    previous.groups === next.groups &&
    previous.tabBarOrder === next.tabBarOrder &&
    previous.activeGroupId === next.activeGroupId &&
    previous.tabGroupLayout === next.tabGroupLayout &&
    previous.openFilesById === next.openFilesById &&
    previous.openFileIds === next.openFileIds &&
    previous.activeEditorFileId === next.activeEditorFileId &&
    previous.activeEditorTabType === next.activeEditorTabType &&
    previous.activeTerminalTabId === next.activeTerminalTabId &&
    previous.activeBrowserWorkspaceId === next.activeBrowserWorkspaceId &&
    previous.generatedTitlesEnabled === next.generatedTitlesEnabled &&
    previous.terminalTheme === next.terminalTheme &&
    narrowedEntriesEqual(previous.terminalLayoutByTabId, next.terminalLayoutByTabId) &&
    narrowedEntriesEqual(previous.paneTitlesByTabId, next.paneTitlesByTabId) &&
    narrowedEntriesEqual(previous.launchDraftByPaneKey, next.launchDraftByPaneKey) &&
    narrowedEntriesEqual(previous.agentStatusByPaneKey, next.agentStatusByPaneKey) &&
    narrowedEntriesEqual(previous.editorDraftVersionByFileId, next.editorDraftVersionByFileId) &&
    narrowedEntriesEqual(previous.pagesByBrowserWorkspaceId, next.pagesByBrowserWorkspaceId) &&
    narrowedEntriesEqual(
      previous.certificateFailureByBrowserPageId,
      next.certificateFailureByBrowserPageId
    ) &&
    // Why: live DOM/PaneManager state is invisible to store references; the
    // capture makes it comparable instead of forcing mounted worktrees to rebuild.
    mountedSurfaceCapturesEqual(
      previous.mountedSurfaceCaptureByTabId,
      next.mountedSurfaceCaptureByTabId
    )
  )
}

export function buildMobileSessionTabSnapshots(
  state: AppState,
  systemPrefersDark = getSystemPrefersDark()
): RuntimeMobileSessionTabsSnapshot[] {
  // Why: high-frequency title ticks fire mobile sync; cache indexes/hashes by store-slice ref to skip rescanning editor state.
  const openFileIndexes = getOpenFileIndexes(state.openFiles)
  const browserTabsByWorktree = getBrowserTabsByWorktree(state)
  const publicationInputs: MobileSessionPublicationInputs = {
    browserTabsByWorktree,
    openFileIndexes,
    editorDraftVersionByFileId: getEditorDraftVersionByFileId(state.editorDrafts),
    agentStatusByWorktreeId: buildMobileSessionAgentStatusByWorktree(
      state.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS_BY_PANE_KEY,
      state.tabsByWorktree
    ),
    generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
    terminalTheme: getMobileTerminalTheme(state, systemPrefersDark)
  }
  const liveFolderWorkspaceIds = new Set(
    (state.folderWorkspaces ?? []).map((workspace) => workspace.id)
  )
  const worktreeIds = new Set<string>([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.groupsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree),
    ...Object.keys(browserTabsByWorktree),
    ...state.openFiles.map((file) => file.worktreeId)
  ])

  const snapshots: RuntimeMobileSessionTabsSnapshot[] = []
  for (const worktreeId of worktreeIds) {
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (
      workspaceScope?.type === 'folder' &&
      !liveFolderWorkspaceIds.has(workspaceScope.folderWorkspaceId)
    ) {
      mobileSessionSnapshotCacheByWorktree.delete(worktreeId)
      continue
    }
    const inputs = buildMobileSessionWorktreeInputs(state, worktreeId, publicationInputs)
    const cached = mobileSessionSnapshotCacheByWorktree.get(worktreeId)
    // Why: invalidate before computing — building the maps, projection, and tab
    // array first made the cache save the fanout but none of the per-worktree work.
    if (cached && canReuseMobileSessionSnapshot(cached.inputs, inputs)) {
      snapshots.push(cached.snapshot)
      continue
    }
    const activeGroupId = inputs.activeGroupId
    const terminalTabByIdForWorktree = new Map(inputs.terminalTabs.map((tab) => [tab.id, tab]))
    const browserWorkspaceByIdForWorktree = new Map(
      inputs.browserWorkspaces.map((workspace) => [workspace.id, workspace])
    )
    const unifiedTabByIdForWorktree = new Map(inputs.unifiedTabs.map((tab) => [tab.id, tab]))
    const openFilesForWorktree = inputs.openFilesById
    const editorIds = inputs.openFileIds.filter((fileId) => {
      const file = openFilesForWorktree?.get(fileId)
      return file ? isMobilePublishableOpenFile(file) : false
    })
    const publishableTerminalIds = [...terminalTabByIdForWorktree.values()]
      .filter(
        (terminal) =>
          !isWebOnlyMirroredTerminalTab(terminal, inputs.terminalLayoutByTabId.get(terminal.id))
      )
      .map((terminal) => terminal.id)
    const groupProjection = buildMobileSessionGroupProjection(inputs, {
      terminalIds: publishableTerminalIds,
      editorIds,
      browserIds: [...browserWorkspaceByIdForWorktree.keys()]
    })
    const tabs: RuntimeMobileSessionSnapshotTab[] = []
    const emittedEditorFileIds = new Set<string>()
    const emittedEditorTabIds = new Set<string>()

    for (const item of groupProjection.order) {
      if (item.type === 'terminal') {
        const terminal = terminalTabByIdForWorktree.get(item.id)
        if (!terminal) {
          continue
        }
        if (isWebOnlyMirroredTerminalTab(terminal, inputs.terminalLayoutByTabId.get(terminal.id))) {
          continue
        }
        tabs.push(...buildMobileTerminalSurfaceTabs(inputs, terminal, item.tabId))
      } else if (item.type === 'editor') {
        const file = openFilesForWorktree?.get(item.id)
        if (!file || !isMobilePublishableOpenFile(file)) {
          continue
        }
        const markdown = buildMobileMarkdownTab(
          inputs,
          file,
          item.tabId ? unifiedTabByIdForWorktree.get(item.tabId) : undefined
        )
        if (markdown) {
          tabs.push(markdown)
        } else {
          tabs.push(
            buildMobileFileTab(
              inputs,
              file,
              item.tabId ? unifiedTabByIdForWorktree.get(item.tabId) : undefined
            )
          )
        }
        emittedEditorFileIds.add(file.id)
        emittedEditorTabIds.add(item.tabId ?? item.id)
      } else if (item.type === 'browser') {
        const workspace = browserWorkspaceByIdForWorktree.get(item.id)
        if (!workspace) {
          continue
        }
        tabs.push(
          buildMobileBrowserTab(
            inputs,
            workspace,
            item.tabId ? unifiedTabByIdForWorktree.get(item.tabId) : undefined
          )
        )
      }
    }

    // Why: split-group projection can miss plain editor files during hydration; publish them so mobile/web still mirror.
    const fallbackEditorTabs: FallbackEditorTabTarget[] = []
    if (openFilesForWorktree) {
      const unifiedEditorTabs = getEditorUnifiedTabsForWorktree(inputs)
      const unifiedEditorFileIds = new Set(unifiedEditorTabs.map((tab) => tab.entityId))
      for (const unifiedTab of unifiedEditorTabs) {
        if (emittedEditorTabIds.has(unifiedTab.id)) {
          continue
        }
        const file = openFilesForWorktree.get(unifiedTab.entityId)
        if (!file || !isMobilePublishableOpenFile(file)) {
          continue
        }
        const markdown = buildMobileMarkdownTab(inputs, file, unifiedTab)
        const fallbackTab = markdown ?? buildMobileFileTab(inputs, file, unifiedTab)
        tabs.push(fallbackTab)
        fallbackEditorTabs.push({
          tabId: fallbackTab.id,
          groupId: unifiedTab.groupId
        })
        emittedEditorTabIds.add(unifiedTab.id)
      }
      for (const file of openFilesForWorktree.values()) {
        if (!isMobilePublishableOpenFile(file)) {
          continue
        }
        if (emittedEditorFileIds.has(file.id)) {
          continue
        }
        if (unifiedEditorFileIds.has(file.id)) {
          emittedEditorFileIds.add(file.id)
          continue
        }
        const markdown = buildMobileMarkdownTab(inputs, file)
        const fallbackTab = markdown ?? buildMobileFileTab(inputs, file)
        tabs.push(fallbackTab)
        fallbackEditorTabs.push({
          tabId: fallbackTab.id,
          groupId: null
        })
        emittedEditorFileIds.add(file.id)
      }
    }

    const active = tabs.find((tab) => tab.isActive) ?? null
    const tabGroups = appendFallbackEditorTabsToGroups(
      groupProjection.tabGroups,
      inputs.groups,
      activeGroupId,
      fallbackEditorTabs,
      active?.id ?? null
    )
    const tabGroupLayout =
      tabGroups && tabGroups.length > 0
        ? pruneTabGroupLayout(inputs.tabGroupLayout, new Set(tabGroups.map((group) => group.id)))
        : groupProjection.tabGroupLayout
    const content = {
      activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      ...(tabGroups && tabGroups.length > 0 ? { tabGroups } : {}),
      ...(tabGroupLayout ? { tabGroupLayout } : {}),
      tabs
    }
    // Why: main suppresses per-worktree fanout on an unchanged (epoch, version)
    // pair, so reuse the cached version for structurally-identical content —
    // the backstop for inputs that churn by reference without changing output.
    // The counter only ever advances, so a later real change still outranks it.
    const candidateVersion = ++mobileSessionSnapshotVersion
    if (cached && jsonContentEquals(cached.content, content)) {
      mobileSessionSnapshotCacheByWorktree.set(worktreeId, {
        inputs,
        content,
        snapshot: cached.snapshot
      })
      snapshots.push(cached.snapshot)
      continue
    }
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch: mobileSessionPublicationEpoch,
      snapshotVersion: candidateVersion,
      ...content
    }
    mobileSessionSnapshotCacheByWorktree.set(worktreeId, { inputs, content, snapshot })
    snapshots.push(snapshot)
  }

  for (const worktreeId of mobileSessionSnapshotCacheByWorktree.keys()) {
    if (!worktreeIds.has(worktreeId)) {
      mobileSessionSnapshotCacheByWorktree.delete(worktreeId)
    }
  }

  return snapshots
}

function isEditorSurfaceTab(tab: Pick<Tab, 'contentType'>): boolean {
  // Why: mobile can mirror ordinary edit/diff files; conflict-review and check-details tabs need metadata this contract lacks.
  return tab.contentType === 'editor' || tab.contentType === 'diff'
}

function getEditorUnifiedTabsForWorktree(
  inputs: Pick<MobileSessionWorktreeInputs, 'unifiedTabs'>
): Tab[] {
  return inputs.unifiedTabs.filter(isEditorSurfaceTab)
}

function applyUnifiedEditorTabIdsToLegacyOrder(
  order: readonly VisibleTabRef[],
  inputs: Pick<MobileSessionWorktreeInputs, 'unifiedTabs'>
): VisibleTabRef[] {
  const unifiedEditorTabs = getEditorUnifiedTabsForWorktree(inputs)
  if (unifiedEditorTabs.length === 0) {
    return [...order]
  }
  const firstUnifiedTabByFileId = new Map<string, string>()
  for (const tab of unifiedEditorTabs) {
    if (!firstUnifiedTabByFileId.has(tab.entityId)) {
      firstUnifiedTabByFileId.set(tab.entityId, tab.id)
    }
  }
  return order.map((item) => {
    if (item.type !== 'editor' || item.tabId) {
      return item
    }
    const tabId = firstUnifiedTabByFileId.get(item.id)
    return tabId ? { ...item, tabId } : item
  })
}

function appendFallbackEditorTabsToGroups(
  tabGroups: RuntimeMobileSessionTabGroup[] | undefined,
  sourceGroups: readonly TabGroup[],
  activeGroupId: string | null,
  fallbackTabs: readonly FallbackEditorTabTarget[],
  activeTabId: string | null
): RuntimeMobileSessionTabGroup[] | undefined {
  if (fallbackTabs.length === 0) {
    return tabGroups
  }
  const result = [...(tabGroups ?? [])]
  const sourceGroupsById = new Map(sourceGroups.map((group) => [group.id, group]))
  const groupIndexById = new Map(result.map((group, index) => [group.id, index]))
  const firstTargetGroupId =
    result[0]?.id ??
    (activeGroupId && sourceGroupsById.has(activeGroupId) ? activeGroupId : null) ??
    sourceGroups[0]?.id ??
    null
  const fallbackTabIdSet = new Set(fallbackTabs.map((tab) => tab.tabId))

  for (const fallback of fallbackTabs) {
    const targetGroupId =
      fallback.groupId ??
      (activeGroupId && (groupIndexById.has(activeGroupId) || sourceGroupsById.has(activeGroupId))
        ? activeGroupId
        : firstTargetGroupId)
    if (!targetGroupId) {
      continue
    }
    let targetIndex = groupIndexById.get(targetGroupId)
    if (targetIndex === undefined) {
      const sourceGroup = sourceGroupsById.get(targetGroupId)
      const group: RuntimeMobileSessionTabGroup = {
        id: targetGroupId,
        activeTabId: sourceGroup?.activeTabId ?? null,
        tabOrder: [],
        recentTabIds: sourceGroup?.recentTabIds ?? []
      }
      targetIndex = result.length
      groupIndexById.set(targetGroupId, targetIndex)
      result.push(group)
    }
    const group = result[targetIndex]!
    if (!group.tabOrder.includes(fallback.tabId)) {
      result[targetIndex] = {
        ...group,
        tabOrder: [...group.tabOrder, fallback.tabId]
      }
    }
  }

  if (result.length === 0) {
    return tabGroups
  }

  const activeFallbackTabId = activeTabId && fallbackTabIdSet.has(activeTabId) ? activeTabId : null

  return result.map((group) => {
    const tabOrder = [...group.tabOrder]
    const tabOrderSet = new Set(tabOrder)
    const activeFallbackTabIdForGroup =
      activeFallbackTabId && tabOrderSet.has(activeFallbackTabId) ? activeFallbackTabId : null
    const activeTabIdForGroup =
      activeFallbackTabIdForGroup ??
      (group.activeTabId && tabOrderSet.has(group.activeTabId) ? group.activeTabId : null)
    const recentTabIds = (group.recentTabIds ?? []).filter((tabId) => tabOrderSet.has(tabId))
    if (
      activeFallbackTabId &&
      tabOrderSet.has(activeFallbackTabId) &&
      !recentTabIds.includes(activeFallbackTabId)
    ) {
      recentTabIds.push(activeFallbackTabId)
    }
    return {
      ...group,
      activeTabId: activeTabIdForGroup,
      tabOrder,
      recentTabIds
    }
  })
}

function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId) !== null
}

function isWebOnlyMirroredTerminalTab(
  tab: Pick<NonNullable<AppState['tabsByWorktree'][string]>[number], 'id' | 'ptyId'>,
  layout: AppState['terminalLayoutsByTabId'][string] | undefined
): boolean {
  if (!isWebTerminalSurfaceTabId(tab.id)) {
    return false
  }
  const layoutPtyIds = Object.values(layout?.ptyIdsByLeafId ?? {})
  const ptyIds = [tab.ptyId, ...layoutPtyIds].filter(
    (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
  )
  // Why: only-remote/no-PTY tabs are web mirrors, not host state; legacy local-PTY tabs still publish for desktop/web parity.
  return ptyIds.every(isRemoteRuntimePtyId)
}

function getOpenFileIndexes(openFiles: AppState['openFiles']): OpenFileIndexes {
  if (cachedOpenFileIndexesSource === openFiles && cachedOpenFileIndexes) {
    return cachedOpenFileIndexes
  }

  const byWorktreeAndId: OpenFileByWorktreeAndId = new Map()
  const idsByWorktree = new Map<string, string[]>()
  for (const file of openFiles) {
    let filesById = byWorktreeAndId.get(file.worktreeId)
    if (!filesById) {
      filesById = new Map()
      byWorktreeAndId.set(file.worktreeId, filesById)
    }
    let ids = idsByWorktree.get(file.worktreeId)
    if (!ids) {
      ids = []
      idsByWorktree.set(file.worktreeId, ids)
    }
    if (!filesById.has(file.id)) {
      filesById.set(file.id, file)
      ids.push(file.id)
    }
  }

  cachedOpenFileIndexesSource = openFiles
  cachedOpenFileIndexes = { byWorktreeAndId, idsByWorktree }
  return cachedOpenFileIndexes
}

function collectTabGroupLayoutIds(layout: TabGroupLayoutNode | undefined): string[] {
  const result: string[] = []
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.push(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

function pruneTabGroupLayout(
  layout: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneTabGroupLayout(layout.first, validGroupIds)
  const second = pruneTabGroupLayout(layout.second, validGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}

function getOrderedTabGroups(
  groups: readonly TabGroup[],
  layout: TabGroupLayoutNode | undefined
): TabGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const seen = new Set<string>()
  const ordered: TabGroup[] = []
  for (const groupId of collectTabGroupLayoutIds(layout)) {
    const group = byId.get(groupId)
    if (!group || seen.has(group.id)) {
      continue
    }
    seen.add(group.id)
    ordered.push(group)
  }
  for (const group of groups) {
    if (!seen.has(group.id)) {
      ordered.push(group)
    }
  }
  return ordered
}

// Why: getActiveTabNavOrder only reads the [worktreeId] entry of each slice, so a single-key view keeps this path off AppState.
function buildLegacyNavOrderView(
  inputs: MobileSessionWorktreeInputs
): Parameters<typeof getActiveTabNavOrder>[0] {
  const { worktreeId } = inputs
  return {
    activeGroupIdByWorktree: inputs.activeGroupId ? { [worktreeId]: inputs.activeGroupId } : {},
    groupsByWorktree: { [worktreeId]: inputs.groups },
    unifiedTabsByWorktree: { [worktreeId]: inputs.unifiedTabs },
    tabBarOrderByWorktree: inputs.tabBarOrder ? { [worktreeId]: inputs.tabBarOrder } : {},
    tabsByWorktree: { [worktreeId]: inputs.terminalTabs },
    openFiles: inputs.openFilesById ? [...inputs.openFilesById.values()] : [],
    browserTabsByWorktree: { [worktreeId]: inputs.browserWorkspaces }
  }
}

function buildMobileSessionGroupProjection(
  inputs: MobileSessionWorktreeInputs,
  ids: {
    terminalIds: string[]
    editorIds: string[]
    browserIds: string[]
  }
): {
  order: VisibleTabRef[]
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
} {
  const groups = inputs.groups
  if (groups.length === 0) {
    return {
      order: applyUnifiedEditorTabIdsToLegacyOrder(
        getActiveTabNavOrder(buildLegacyNavOrderView(inputs), inputs.worktreeId, {
          editorIds: ids.editorIds
        }),
        inputs
      )
    }
  }

  const terminalIds = new Set(ids.terminalIds)
  const editorIds = new Set(ids.editorIds)
  const browserIds = new Set(ids.browserIds)
  const tabs = inputs.unifiedTabs
  const order: VisibleTabRef[] = []
  const tabGroups: RuntimeMobileSessionTabGroup[] = []

  for (const group of getOrderedTabGroups(groups, inputs.tabGroupLayout)) {
    const groupTabs = tabs.filter((tab) => tab.groupId === group.id)
    const visibleOrder = getGroupVisibleTabOrder(
      group,
      groupTabs,
      terminalIds,
      editorIds,
      browserIds
    )
    if (visibleOrder.length === 0) {
      continue
    }
    const tabOrder = visibleOrder.map((item) => item.tabId ?? item.id)
    const tabOrderSet = new Set(tabOrder)
    // Why: persisted split groups can have very large tab orders; append iteratively to avoid V8's argument-list limit.
    for (const item of visibleOrder) {
      order.push(item)
    }
    tabGroups.push({
      id: group.id,
      activeTabId:
        group.activeTabId && tabOrderSet.has(group.activeTabId) ? group.activeTabId : null,
      tabOrder,
      recentTabIds: group.recentTabIds?.filter((tabId) => tabOrderSet.has(tabId)) ?? []
    })
  }

  const validGroupIds = new Set(tabGroups.map((group) => group.id))
  return {
    order,
    tabGroups,
    tabGroupLayout: pruneTabGroupLayout(inputs.tabGroupLayout, validGroupIds)
  }
}

function getEditorDraftVersionByFileId(
  editorDrafts: AppState['editorDrafts']
): Map<string, string> {
  if (cachedEditorDraftsSource === editorDrafts && cachedEditorDraftVersionByFileId) {
    return cachedEditorDraftVersionByFileId
  }

  const versions = new Map<string, string>()
  for (const [fileId, content] of Object.entries(editorDrafts)) {
    versions.set(fileId, stableHashString(content))
  }
  cachedEditorDraftsSource = editorDrafts
  cachedEditorDraftVersionByFileId = versions
  return versions
}

function mobileTerminalSurfaceId(parentTabId: string, leafId: string): string {
  return `${parentTabId}::${leafId}`
}

function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

function resolveMobileTerminalTheme(
  state: AppState,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  const settings = state.settings
  if (!settings) {
    return undefined
  }
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const resolvedTheme = appearance.theme
    ? { ...appearance.theme, ...settings.terminalColorOverrides }
    : undefined
  if (!resolvedTheme) {
    return undefined
  }
  if (settings.terminalBackgroundOpacity !== undefined && isHexColor(resolvedTheme.background)) {
    resolvedTheme.background = hexToRgba(
      resolvedTheme.background,
      settings.terminalBackgroundOpacity
    )
  }
  if (settings.terminalCursorOpacity !== undefined && isHexColor(resolvedTheme.cursor)) {
    resolvedTheme.cursor = hexToRgba(resolvedTheme.cursor, settings.terminalCursorOpacity)
  }

  const theme: Record<string, string> = {}
  for (const [key, value] of Object.entries(resolvedTheme)) {
    if (typeof value === 'string') {
      theme[key] = value
    }
  }
  return { mode: appearance.mode, theme: theme as RuntimeMobileTerminalTheme['theme'] }
}

function getRuntimeLeafIdsForTerminal(
  capture: MountedTerminalSurfaceCapture | undefined,
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): readonly string[] {
  const liveLeafIds = capture?.paneLeafIds ?? []
  if (liveLeafIds.length > 0) {
    return liveLeafIds
  }

  const persistedLeafIds = collectLeafIdsInOrder(savedLayout?.root).filter(isTerminalLeafId)
  if (persistedLeafIds.length > 0) {
    return persistedLeafIds
  }

  // Why: a new tab can predate TerminalPane mount; fabricating pane:1 with no live/persisted leaf would go stale after mount.
  return []
}

function resolveMobileTabWideAgentHintLeafId(
  capture: MountedTerminalSurfaceCapture | undefined,
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): string | null {
  if (capture) {
    return capture.tabWideAgentHintLeafId
  }
  return isNativeChatTabWideFallbackSafe(savedLayout)
    ? resolveNativeChatActiveLayoutLeafId(savedLayout)
    : null
}

function buildMobileLaunchDraftsByPaneKey(args: {
  terminalTabs: AppState['tabsByWorktree'][string]
  terminalLayoutByTabId: MobileSessionWorktreeInputs['terminalLayoutByTabId']
  mountedSurfaceCaptureByTabId: MobileSessionWorktreeInputs['mountedSurfaceCaptureByTabId']
  launchDraftByTabId: ReadonlyMap<
    string,
    NonNullable<AppState['nativeChatLaunchDraftByTabId']>[string]
  >
}): MobileSessionWorktreeInputs['launchDraftByPaneKey'] {
  if (args.launchDraftByTabId.size === 0) {
    return EMPTY_NARROWED_BY_KEY
  }
  let draftsByPaneKey: Map<
    string,
    NonNullable<AppState['nativeChatLaunchDraftByTabId']>[string]
  > | null = null
  for (const terminal of args.terminalTabs) {
    const draft = args.launchDraftByTabId.get(terminal.id)
    if (!draft || draft.resolved) {
      continue
    }
    const capture = args.mountedSurfaceCaptureByTabId.get(terminal.id)
    const savedLayout = args.terminalLayoutByTabId.get(terminal.id)
    const leafIds = getRuntimeLeafIdsForTerminal(capture, savedLayout)
    const ownerLeafId = resolveMobileTabWideAgentHintLeafId(capture, savedLayout)
    const launchAgent = nativeChatLaunchAgentForLeaf({
      launchAgent: terminal.launchAgent,
      launchAgentLeafId: ownerLeafId,
      leafId: ownerLeafId,
      leafIds
    })
    if (!launchAgent || launchAgent !== draft.agent || !ownerLeafId) {
      continue
    }
    draftsByPaneKey ??= new Map()
    draftsByPaneKey.set(makePaneKey(terminal.id, ownerLeafId), draft)
  }
  return draftsByPaneKey ?? EMPTY_NARROWED_BY_KEY
}

function buildMobileTerminalSurfaceTabs(
  inputs: MobileSessionWorktreeInputs,
  terminal: NonNullable<AppState['tabsByWorktree'][string]>[number],
  unifiedTabId?: string
): RuntimeMobileSessionSnapshotTab[] {
  const capture = inputs.mountedSurfaceCaptureByTabId.get(terminal.id)
  const isDesktopTabActive = unifiedTabId
    ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
    : inputs.activeTerminalTabId === terminal.id
  const savedLayout = inputs.terminalLayoutByTabId.get(terminal.id)
  const leafIds = getRuntimeLeafIdsForTerminal(capture, savedLayout)
  const launchAgentLeafId = resolveMobileTabWideAgentHintLeafId(capture, savedLayout)
  const activeLeafId = capture?.hasLiveActivePane
    ? capture.liveActiveLeafId
    : (savedLayout?.activeLeafId ?? leafIds[0] ?? null)
  const paneTitles = inputs.paneTitlesByTabId.get(terminal.id) ?? {}
  const generatedTitlesEnabled = inputs.generatedTitlesEnabled
  const sanitizedSavedLayout = savedLayout
    ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminal)
    : undefined
  const savedPtyIdsByLeafId = sanitizedSavedLayout?.ptyIdsByLeafId ?? {}
  const terminalTheme = inputs.terminalTheme
  const liveLayoutRoot = capture?.liveLayoutRoot ?? null
  const parentLayout = normalizeTerminalLayoutSnapshot({
    // Why: live DOM tree is authoritative when mounted, else the saved tree; synthesize only as a last resort, never re-guess.
    root: resolveTerminalLayoutRoot({
      authoritativeRoot: liveLayoutRoot,
      existingRoot: sanitizedSavedLayout?.root,
      leafIds,
      onSynthesize: (leafCount) =>
        console.warn(
          `[sync-runtime-graph] synthesized parentLayout for ${leafCount} leaves with no live or saved tree`
        )
    }),
    activeLeafId,
    expandedLeafId: sanitizedSavedLayout?.expandedLeafId ?? null,
    ...(Object.keys(savedPtyIdsByLeafId).length > 0 ? { ptyIdsByLeafId: savedPtyIdsByLeafId } : {}),
    ...(sanitizedSavedLayout?.titlesByLeafId
      ? { titlesByLeafId: sanitizedSavedLayout.titlesByLeafId }
      : {})
  } satisfies TerminalLayoutSnapshot).snapshot
  return leafIds.map((leafId) => {
    const numericPaneId = capture?.numericPaneIdByLeafId.get(leafId) ?? null
    const ptyId =
      numericPaneId === null
        ? (savedPtyIdsByLeafId[leafId] ?? (leafIds.length === 1 ? terminal.ptyId : null))
        : (capture?.ptyIdByNumericPaneId.get(numericPaneId) ?? savedPtyIdsByLeafId[leafId] ?? null)
    const legacyPaneId = numericPaneId === null ? /^pane:(\d+)$/.exec(leafId)?.[1] : null
    const paneTitle =
      numericPaneId !== null
        ? paneTitles[numericPaneId]
        : legacyPaneId
          ? paneTitles[Number(legacyPaneId)]
          : undefined
    const leafTitle = paneTitle?.trim() || sanitizedSavedLayout?.titlesByLeafId?.[leafId]?.trim()
    const paneKey = isTerminalLeafId(leafId) ? makePaneKey(terminal.id, leafId) : null
    const tabWideFallbackSafe =
      isNativeChatTabWideFallbackSafe(parentLayout) && launchAgentLeafId === leafId
    const title = tabWideFallbackSafe
      ? resolveRuntimeTerminalTitle(
          terminal,
          generatedTitlesEnabled,
          leafTitle ?? terminal.title ?? 'Terminal'
        )
      : (leafTitle ?? 'Terminal')
    const agentStatusTitle = leafTitle ?? (tabWideFallbackSafe ? terminal.title : '') ?? ''
    const agentStatus =
      paneKey && !isClaudeManagementTitle(agentStatusTitle)
        ? inputs.agentStatusByPaneKey.get(paneKey)
        : undefined
    const launchAgent = nativeChatLaunchAgentForLeaf({
      launchAgent: terminal.launchAgent,
      launchAgentLeafId,
      leafId,
      leafIds
    })
    const launchDraft = paneKey ? inputs.launchDraftByPaneKey.get(paneKey) : undefined
    const publishedLaunchDraft =
      launchDraft && launchDraft.agent === launchAgent && launchDraft.text.trim()
        ? launchDraft
        : null
    return {
      type: 'terminal' as const,
      id: mobileTerminalSurfaceId(terminal.id, leafId),
      title,
      ...(tabWideFallbackSafe && terminal.quickCommandLabel?.trim()
        ? { quickCommandLabel: terminal.quickCommandLabel.trim() }
        : {}),
      parentTabId: terminal.id,
      leafId,
      ptyId,
      ...(terminalTheme ? { terminalTheme } : {}),
      ...(agentStatus ? { agentStatus } : {}),
      ...(launchAgent ? { launchAgent } : {}),
      // Launch context that exists only as an unsent TUI-input draft; mobile
      // prefills its chat composer from it (desktop keeps its own seed store).
      ...(publishedLaunchDraft
        ? {
            launchDraft: publishedLaunchDraft.text,
            launchDraftCreatedAt: publishedLaunchDraft.createdAt
          }
        : {}),
      parentLayout,
      isActive: isDesktopTabActive && leafId === activeLeafId
    }
  })
}

function buildMobileMarkdownTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionMarkdownTab | null {
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return null
  }
  if (file.language !== 'markdown' && file.mode !== 'markdown-preview') {
    return null
  }

  const sourceFile =
    file.mode === 'markdown-preview' && file.markdownPreviewSourceFileId
      ? (inputs.openFilesById?.get(file.markdownPreviewSourceFileId) ?? file)
      : file
  const draftVersion = inputs.editorDraftVersionByFileId.get(sourceFile.id)
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'Markdown'
  const unifiedTabId = unifiedTab?.id

  return {
    type: 'markdown',
    id: unifiedTabId ?? file.id,
    title,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: 'markdown',
    mode: file.mode,
    isDirty: file.isDirty || sourceFile.isDirty,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : isFileActiveEditorSurface(inputs, file),
    sourceFileId: sourceFile.id,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    documentVersion: draftVersion ?? `file:${sourceFile.id}`,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true
  }
}

function buildMobileFileTab(
  inputs: MobileSessionWorktreeInputs,
  file: AppState['openFiles'][number],
  unifiedTab?: Tab
): RuntimeMobileSessionFileTab {
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'File'
  const diffSource = isMobileFileDiffSource(file.diffSource) ? file.diffSource : undefined
  const unifiedTabId = unifiedTab?.id

  return {
    type: 'file',
    id: unifiedTabId ?? file.id,
    title,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    mode: file.mode === 'diff' ? 'diff' : 'edit',
    ...(diffSource ? { diffSource } : {}),
    isDirty: file.isDirty,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : isFileActiveEditorSurface(inputs, file)
  }
}

function isFileActiveEditorSurface(
  inputs: Pick<MobileSessionWorktreeInputs, 'activeEditorFileId' | 'activeEditorTabType'>,
  file: Pick<AppState['openFiles'][number], 'id'>
): boolean {
  return inputs.activeEditorTabType === 'editor' && inputs.activeEditorFileId === file.id
}

function isMobileFileDiffSource(
  diffSource: AppState['openFiles'][number]['diffSource']
): diffSource is 'staged' | 'unstaged' {
  return diffSource === 'staged' || diffSource === 'unstaged'
}

function isMobileUnsupportedCombinedDiffSource(
  diffSource: AppState['openFiles'][number]['diffSource']
): boolean {
  return (
    diffSource === 'combined-all' ||
    diffSource === 'combined-uncommitted' ||
    diffSource === 'combined-branch' ||
    diffSource === 'combined-commit'
  )
}

function isMobilePublishableOpenFile(file: AppState['openFiles'][number]): boolean {
  // Why: combined diff tabs use display labels as paths and need the desktop renderer; mobile would mis-call files.read.
  return !isMobileUnsupportedCombinedDiffSource(file.diffSource)
}

// Why: the store buckets a workspace under its own worktreeId, so this worktree's scoped inputs are the workspace's own scope.
function buildMobileBrowserTab(
  inputs: MobileSessionWorktreeInputs,
  workspace: NonNullable<AppState['browserTabsByWorktree'][string]>[number],
  unifiedTab?: Tab
): RuntimeMobileSessionBrowserTab {
  const pages = inputs.pagesByBrowserWorkspaceId.get(workspace.id) ?? []
  const activePage = pages.find((page) => page.id === workspace.activePageId) ?? pages[0] ?? null
  const title =
    activePage?.title || workspace.title || activePage?.url || workspace.url || 'Browser'
  const unifiedTabId = unifiedTab?.id

  return {
    type: 'browser',
    id: unifiedTabId ?? workspace.id,
    title,
    browserWorkspaceId: workspace.id,
    browserPageId: activePage?.id ?? workspace.activePageId ?? null,
    url: activePage?.url ?? workspace.url ?? 'about:blank',
    loading: activePage?.loading ?? workspace.loading,
    canGoBack: activePage?.canGoBack ?? workspace.canGoBack,
    canGoForward: activePage?.canGoForward ?? workspace.canGoForward,
    // Why: null means the active page cleared its failure; ?? would resurrect a stale workspace-level error.
    loadError: activePage ? activePage.loadError : workspace.loadError,
    certificateFailure: activePage
      ? (inputs.certificateFailureByBrowserPageId.get(activePage.id) ?? null)
      : null,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : inputs.activeBrowserWorkspaceId === workspace.id
  }
}

function isUnifiedTabActiveInActiveGroup(
  inputs: Pick<MobileSessionWorktreeInputs, 'groups' | 'activeGroupId'>,
  unifiedTabId: string
): boolean {
  return inputs.groups.some(
    (group) => group.id === inputs.activeGroupId && group.activeTabId === unifiedTabId
  )
}

function stableHashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `draft:${value.length}:${(hash >>> 0).toString(16)}`
}
