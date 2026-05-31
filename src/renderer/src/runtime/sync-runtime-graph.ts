/* eslint-disable max-lines -- Why: runtime graph sync and mobile session-tab publication share the same injected renderer state and terminal registry. Keeping them together prevents a second store/registry reader from drifting. */
import {
  collectLeafIdsInOrder,
  serializePaneTree,
  normalizeTerminalLayoutSnapshot
} from '@/components/terminal-pane/layout-serialization'
import { warnTerminalLifecycleAnomaly } from '@/components/terminal-pane/terminal-lifecycle-diagnostics'
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
  RuntimeSyncWindowGraph
} from '../../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type {
  TabGroup,
  TabGroupLayoutNode,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/types'
import { resolveTerminalTabTitle } from '../../../shared/tab-title-resolution'
import {
  getActiveTabNavOrder,
  getGroupVisibleTabOrder,
  type VisibleTabRef
} from '../components/tab-bar/group-tab-order'
import { parseRemoteRuntimePtyId } from './runtime-terminal-stream'

type RegisteredTerminalTab = {
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getContainer: () => HTMLDivElement | null
  getPtyIdForPane: (paneId: number) => string | null
}

type OpenFileByWorktreeAndId = Map<string, Map<string, AppState['openFiles'][number]>>
type OpenFileIndexes = {
  byWorktreeAndId: OpenFileByWorktreeAndId
  idsByWorktree: Map<string, string[]>
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

const registeredTabs = new Map<string, RegisteredTerminalTab>()
// Why: track when each tab was registered so we can suppress the "no live
// transport" warning during the initial PTY connection window. The warning
// is noise when it fires on mount (PTY spawn/attach is async and hasn't
// finished yet), but valuable if the transport is still missing after the
// grace period — that indicates a real stuck state.
const tabRegisteredAt = new Map<string, number>()
const NO_TRANSPORT_GRACE_MS = 10_000
const EMPTY_ACTIVE_BROWSER_TAB_ID_BY_WORKTREE: AppState['activeBrowserTabIdByWorktree'] = {}
const EMPTY_BROWSER_TABS_BY_WORKTREE: AppState['browserTabsByWorktree'] = {}
const EMPTY_BROWSER_PAGES_BY_WORKSPACE: AppState['browserPagesByWorkspace'] = {}
const EMPTY_LAYOUT_BY_WORKTREE: AppState['layoutByWorktree'] = {}
const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
const AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS = 30_000
let syncScheduled = false
let syncInFlight = false
let syncPendingAfterFlight = false
let syncEnabled = false
let getStoreState: (() => AppState) | null = null
let mobileSessionSnapshotVersion = 0
let cachedTabsProjection: TabsProjectionCache | null = null
let cachedOpenFileIndexesSource: AppState['openFiles'] | null = null
let cachedOpenFileIndexes: OpenFileIndexes | null = null
let cachedEditorDraftsSource: AppState['editorDrafts'] | null = null
let cachedEditorDraftVersionByFileId: Map<string, string> | null = null
const mobileSessionPublicationEpoch = `renderer:${createBrowserUuid()}`

export function setRuntimeGraphStoreStateGetter(getter: (() => AppState) | null): void {
  getStoreState = getter
}

export function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void {
  registeredTabs.set(tab.tabId, tab)
  tabRegisteredAt.set(tab.tabId, Date.now())
  scheduleRuntimeGraphSync()
  return () => {
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
  if (enabled) {
    scheduleRuntimeGraphSync()
  }
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
  queueMicrotask(() => {
    syncScheduled = false
    void runRuntimeGraphSync()
  })
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
      // Why: syncWindowGraph crosses IPC and can be slower than title/layout
      // churn. Collapse all updates that arrived during one in-flight sync
      // into a single trailing graph instead of stacking concurrent IPC calls.
      scheduleRuntimeGraphSync()
    }
  }
}

export type RuntimeMobileSessionSyncKey = {
  // Why: large maps the renderer never reshapes are compared by reference.
  // Reallocating `terminalLayoutsByTabId` / `runtimePaneTitlesByTabId` is the
  // signal that some pane layout or pane title actually changed; nothing else
  // in the store rewrites those references. Comparing references avoids
  // stringifying potentially thousands of accumulated tab entries on every
  // `setActivePane` / `updateTabTitle` mutation. See
  // docs/agent-working-pane-typing-lag.md.
  terminalLayoutsByTabId: AppState['terminalLayoutsByTabId']
  runtimePaneTitlesByTabId: AppState['runtimePaneTitlesByTabId']
  groupsByWorktree: AppState['groupsByWorktree']
  activeGroupIdByWorktree: AppState['activeGroupIdByWorktree']
  layoutByWorktree: AppState['layoutByWorktree']
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
  tabBarOrderByWorktree: AppState['tabBarOrderByWorktree']
  activeFileId: AppState['activeFileId']
  activeFileIdByWorktree: AppState['activeFileIdByWorktree']
  activeTabId: AppState['activeTabId']
  activeBrowserTabIdByWorktree: AppState['activeBrowserTabIdByWorktree']
  agentStatusEpoch: number
  agentStatusProjection: string
  generatedTabTitlesEnabled: boolean
  systemPrefersDark: boolean | null
  terminalThemeProjection: string
  // Why: these projections still need value-level inspection because the
  // underlying references churn even when the mobile-relevant shape is
  // unchanged (`tabsByWorktree` reallocates on every OSC title frame).
  // Pre-serialize them once.
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
    state.browserTabsByWorktree === previousState.browserTabsByWorktree &&
    state.browserPagesByWorkspace === previousState.browserPagesByWorkspace &&
    state.activeBrowserTabIdByWorktree === previousState.activeBrowserTabIdByWorktree &&
    state.openFiles === previousState.openFiles &&
    state.editorDrafts === previousState.editorDrafts &&
    state.settings === previousState.settings &&
    state.activeTabId === previousState.activeTabId &&
    state.terminalLayoutsByTabId === previousState.terminalLayoutsByTabId &&
    state.runtimePaneTitlesByTabId === previousState.runtimePaneTitlesByTabId &&
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
    groupsByWorktree: state.groupsByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    layoutByWorktree: state.layoutByWorktree ?? EMPTY_LAYOUT_BY_WORKTREE,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabBarOrderByWorktree: state.tabBarOrderByWorktree,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeTabId: state.activeTabId,
    activeBrowserTabIdByWorktree:
      state.activeBrowserTabIdByWorktree ?? EMPTY_ACTIVE_BROWSER_TAB_ID_BY_WORKTREE,
    // Why: paired web/mobile snapshots include full agentStatus details. The
    // epoch covers sort/retention/freshness transitions; the projection covers
    // prompt/tool details without publishing every timestamp-only heartbeat.
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
    // Why: background agent title ticks can change runtimePaneTitlesByTabId
    // many times per second while the user types elsewhere. Reuse unchanged
    // projections so those ticks do not rescan all tabs, files, and drafts.
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
  // Why: some runtime-sync callers and tests construct partial pre-browser
  // renderer states; treat missing browser slices as no browser tabs.
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
  tab: Pick<TerminalTab, 'customTitle' | 'generatedTitle' | 'title'>,
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

function buildRuntimeMobileAgentStatusProjection(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
): string {
  return JSON.stringify(
    Object.entries(agentStatusByPaneKey)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([paneKey, entry]) => ({
        paneKey,
        entryPaneKey: entry.paneKey,
        state: entry.state,
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
        lastAssistantMessage: entry.lastAssistantMessage ?? null,
        interrupted: entry.interrupted ?? null
      }))
  )
}

export function runtimeMobileSessionSyncKeysEqual(
  a: RuntimeMobileSessionSyncKey,
  b: RuntimeMobileSessionSyncKey
): boolean {
  return (
    a.terminalLayoutsByTabId === b.terminalLayoutsByTabId &&
    a.runtimePaneTitlesByTabId === b.runtimePaneTitlesByTabId &&
    a.groupsByWorktree === b.groupsByWorktree &&
    a.activeGroupIdByWorktree === b.activeGroupIdByWorktree &&
    a.layoutByWorktree === b.layoutByWorktree &&
    a.unifiedTabsByWorktree === b.unifiedTabsByWorktree &&
    a.tabBarOrderByWorktree === b.tabBarOrderByWorktree &&
    a.activeFileId === b.activeFileId &&
    a.activeFileIdByWorktree === b.activeFileIdByWorktree &&
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
  // Why: the runtime graph helper cannot import the Zustand store directly
  // because the terminal slice also imports this module to schedule syncs.
  // Injecting the getter from App keeps the runtime graph path out of the
  // store construction cycle and avoids test-time partial initialization.
  const state = getStoreState()
  const systemPrefersDark = getSystemPrefersDark()
  // Why: sync can run after high-churn terminal/title mutations. Build lookup
  // maps once per sync instead of flattening every worktree's tabs for each
  // registered terminal.
  const terminalTabById = new Map(
    Object.values(state.tabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab])
  )
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const graph: RuntimeSyncWindowGraph = {
    tabs: [],
    leaves: [],
    mobileSessionTabs: buildMobileSessionTabSnapshots(state, systemPrefersDark)
  }

  for (const [tabId, registeredTab] of registeredTabs) {
    const tab = terminalTabById.get(tabId)
    if (!tab) {
      continue
    }
    if (isWebOnlyMirroredTerminalTab(state, tab)) {
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

  try {
    await window.api.runtime.syncWindowGraph(graph)
  } catch (error) {
    console.error('[runtime] Failed to sync renderer graph:', error)
  }
}

export function buildMobileSessionTabSnapshots(
  state: AppState,
  systemPrefersDark = getSystemPrefersDark()
): RuntimeMobileSessionTabsSnapshot[] {
  // Why: mobile publication can run on high-frequency background agent title
  // ticks. Cache open-file indexes and draft hashes by immutable store-slice
  // reference so title-only syncs do not rescan or rehash editor state.
  const openFileIndexes = getOpenFileIndexes(state.openFiles)
  const editorDraftVersionByFileId = getEditorDraftVersionByFileId(state.editorDrafts)
  const worktreeIds = new Set<string>([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.groupsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree),
    ...Object.keys(getBrowserTabsByWorktree(state)),
    ...state.openFiles.map((file) => file.worktreeId)
  ])

  const snapshots: RuntimeMobileSessionTabsSnapshot[] = []
  for (const worktreeId of worktreeIds) {
    const activeGroupId = state.activeGroupIdByWorktree[worktreeId] ?? null
    const terminalTabByIdForWorktree = new Map(
      (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
    )
    const browserWorkspaceByIdForWorktree = new Map(
      (getBrowserTabsByWorktree(state)[worktreeId] ?? []).map((workspace) => [
        workspace.id,
        workspace
      ])
    )
    const editorIds = openFileIndexes.idsByWorktree.get(worktreeId) ?? []
    const publishableTerminalIds = [...terminalTabByIdForWorktree.values()]
      .filter((terminal) => !isWebOnlyMirroredTerminalTab(state, terminal))
      .map((terminal) => terminal.id)
    const groupProjection = buildMobileSessionGroupProjection(state, worktreeId, {
      terminalIds: publishableTerminalIds,
      editorIds,
      browserIds: [...browserWorkspaceByIdForWorktree.keys()]
    })
    const tabs: RuntimeMobileSessionSnapshotTab[] = []

    for (const item of groupProjection.order) {
      if (item.type === 'terminal') {
        const terminal = terminalTabByIdForWorktree.get(item.id)
        if (!terminal) {
          continue
        }
        if (isWebOnlyMirroredTerminalTab(state, terminal)) {
          continue
        }
        tabs.push(
          ...buildMobileTerminalSurfaceTabs(
            state,
            terminal,
            worktreeId,
            systemPrefersDark,
            item.tabId
          )
        )
      } else if (item.type === 'editor') {
        const file = openFileIndexes.byWorktreeAndId.get(worktreeId)?.get(item.id)
        if (!file) {
          continue
        }
        const markdown = buildMobileMarkdownTab(
          state,
          openFileIndexes.byWorktreeAndId,
          editorDraftVersionByFileId,
          file,
          item.tabId
        )
        if (markdown) {
          tabs.push(markdown)
        } else {
          tabs.push(buildMobileFileTab(state, file, item.tabId))
        }
      } else if (item.type === 'browser') {
        const workspace = browserWorkspaceByIdForWorktree.get(item.id)
        if (!workspace) {
          continue
        }
        tabs.push(buildMobileBrowserTab(state, workspace, item.tabId))
      }
    }

    const active = tabs.find((tab) => tab.isActive) ?? null
    snapshots.push({
      worktree: worktreeId,
      publicationEpoch: mobileSessionPublicationEpoch,
      snapshotVersion: ++mobileSessionSnapshotVersion,
      activeGroupId,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      ...(groupProjection.tabGroups && groupProjection.tabGroups.length > 0
        ? { tabGroups: groupProjection.tabGroups }
        : {}),
      ...(groupProjection.tabGroupLayout ? { tabGroupLayout: groupProjection.tabGroupLayout } : {}),
      tabs
    })
  }

  return snapshots
}

function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId) !== null
}

function isWebOnlyMirroredTerminalTab(
  state: Pick<AppState, 'terminalLayoutsByTabId'>,
  tab: Pick<NonNullable<AppState['tabsByWorktree'][string]>[number], 'id' | 'ptyId'>
): boolean {
  if (!isWebTerminalSurfaceTabId(tab.id)) {
    return false
  }
  const layoutPtyIds = Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  const ptyIds = [tab.ptyId, ...layoutPtyIds].filter(
    (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
  )
  // Why: web mirror ids are a web-renderer implementation detail. If such an
  // id has only remote/no PTYs, it is a mirror and must not be published back
  // as host state. Legacy leaked host tabs with local PTYs still publish so
  // existing sessions keep desktop/web parity.
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

function buildMobileSessionGroupProjection(
  state: AppState,
  worktreeId: string,
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
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (groups.length === 0) {
    return {
      order: getActiveTabNavOrder(state, worktreeId, {
        editorIds: ids.editorIds
      })
    }
  }

  const terminalIds = new Set(ids.terminalIds)
  const editorIds = new Set(ids.editorIds)
  const browserIds = new Set(ids.browserIds)
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const order: VisibleTabRef[] = []
  const tabGroups: RuntimeMobileSessionTabGroup[] = []

  const layoutByWorktree = state.layoutByWorktree ?? {}
  for (const group of getOrderedTabGroups(groups, layoutByWorktree[worktreeId])) {
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
    // Why: persisted split groups can contain very large tab orders; append
    // iteratively so mobile sync does not hit V8's argument-list limit.
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
    tabGroupLayout: pruneTabGroupLayout(layoutByWorktree[worktreeId], validGroupIds)
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
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
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

function fallbackLayoutForLeafIds(leafIds: readonly string[]): TerminalPaneLayoutNode | null {
  const leaves = leafIds.filter(isTerminalLeafId)
  if (leaves.length === 0) {
    return null
  }
  return leaves.slice(1).reduce<TerminalPaneLayoutNode>(
    (root, leafId) => ({
      type: 'split',
      direction: 'horizontal',
      first: root,
      second: { type: 'leaf', leafId }
    }),
    { type: 'leaf', leafId: leaves[0]! }
  )
}

function getRuntimeLeafIdsForTerminal(tabId: string, state: AppState): string[] {
  const registered = registeredTabs.get(tabId)
  const manager = registered?.getManager()
  const liveLeafIds = manager?.getPanes().map((pane) => pane.leafId) ?? []
  if (liveLeafIds.length > 0) {
    return liveLeafIds
  }

  const layout = state.terminalLayoutsByTabId[tabId]
  const persistedLeafIds = collectLeafIdsInOrder(layout?.root).filter(isTerminalLeafId)
  if (persistedLeafIds.length > 0) {
    return persistedLeafIds
  }

  // Why: a newly-created terminal tab can be in the store before TerminalPane
  // mounts. Without a live or persisted UUID leaf, there is no stable mobile
  // surface to publish yet; fabricating pane:1 would become stale after mount.
  return []
}

function buildMobileTerminalSurfaceTabs(
  state: AppState,
  terminal: NonNullable<AppState['tabsByWorktree'][string]>[number],
  worktreeId: string,
  systemPrefersDark: boolean,
  unifiedTabId?: string
): RuntimeMobileSessionSnapshotTab[] {
  const registered = registeredTabs.get(terminal.id)
  const isDesktopTabActive = unifiedTabId
    ? state.groupsByWorktree[worktreeId]?.some(
        (group) =>
          group.id === state.activeGroupIdByWorktree[worktreeId] &&
          group.activeTabId === unifiedTabId
      ) === true
    : state.activeTabId === terminal.id
  const manager = registered?.getManager()
  const liveActivePaneId = manager?.getActivePane()?.id ?? null
  const leafIds = getRuntimeLeafIdsForTerminal(terminal.id, state)
  const activeLeafId =
    liveActivePaneId !== null
      ? (manager?.getLeafId(liveActivePaneId) ?? null)
      : (state.terminalLayoutsByTabId[terminal.id]?.activeLeafId ?? leafIds[0] ?? null)
  const paneTitles = state.runtimePaneTitlesByTabId[terminal.id] ?? {}
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const savedLayout = state.terminalLayoutsByTabId[terminal.id]
  const sanitizedSavedLayout = savedLayout
    ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminal)
    : undefined
  const savedPtyIdsByLeafId = sanitizedSavedLayout?.ptyIdsByLeafId ?? {}
  const terminalTheme = resolveMobileTerminalTheme(state, systemPrefersDark)
  const container = registered?.getContainer()
  const firstChild = container?.firstElementChild
  const liveLayoutRoot = serializePaneTree(
    typeof HTMLElement !== 'undefined' && firstChild instanceof HTMLElement ? firstChild : null
  )
  const parentLayout = normalizeTerminalLayoutSnapshot({
    root: liveLayoutRoot ?? sanitizedSavedLayout?.root ?? fallbackLayoutForLeafIds(leafIds),
    activeLeafId,
    expandedLeafId: sanitizedSavedLayout?.expandedLeafId ?? null,
    ...(Object.keys(savedPtyIdsByLeafId).length > 0 ? { ptyIdsByLeafId: savedPtyIdsByLeafId } : {}),
    ...(sanitizedSavedLayout?.titlesByLeafId
      ? { titlesByLeafId: sanitizedSavedLayout.titlesByLeafId }
      : {})
  } satisfies TerminalLayoutSnapshot).snapshot
  return leafIds.map((leafId) => {
    const numericPaneId = manager?.getNumericIdForLeaf(leafId) ?? null
    const ptyId =
      numericPaneId === null
        ? (savedPtyIdsByLeafId[leafId] ?? (leafIds.length === 1 ? terminal.ptyId : null))
        : (registered?.getPtyIdForPane(numericPaneId) ?? savedPtyIdsByLeafId[leafId] ?? null)
    const legacyPaneId = numericPaneId === null ? /^pane:(\d+)$/.exec(leafId)?.[1] : null
    const paneTitle =
      numericPaneId !== null
        ? paneTitles[numericPaneId]
        : legacyPaneId
          ? paneTitles[Number(legacyPaneId)]
          : undefined
    const paneKey = isTerminalLeafId(leafId) ? makePaneKey(terminal.id, leafId) : null
    const agentStatus = paneKey ? state.agentStatusByPaneKey?.[paneKey] : undefined
    return {
      type: 'terminal' as const,
      id: mobileTerminalSurfaceId(terminal.id, leafId),
      title: resolveRuntimeTerminalTitle(
        terminal,
        generatedTitlesEnabled,
        paneTitle ?? terminal.title ?? 'Terminal'
      ),
      parentTabId: terminal.id,
      leafId,
      ptyId,
      ...(terminalTheme ? { terminalTheme } : {}),
      ...(agentStatus ? { agentStatus } : {}),
      ...(terminal.launchAgent ? { launchAgent: terminal.launchAgent } : {}),
      parentLayout,
      isActive: isDesktopTabActive && leafId === activeLeafId
    }
  })
}

function buildMobileMarkdownTab(
  state: AppState,
  openFileByWorktreeAndId: OpenFileByWorktreeAndId,
  editorDraftVersionByFileId: ReadonlyMap<string, string>,
  file: AppState['openFiles'][number],
  unifiedTabId?: string
): RuntimeMobileSessionMarkdownTab | null {
  if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
    return null
  }
  if (file.language !== 'markdown' && file.mode !== 'markdown-preview') {
    return null
  }

  const sourceFile =
    file.mode === 'markdown-preview' && file.markdownPreviewSourceFileId
      ? (openFileByWorktreeAndId.get(file.worktreeId)?.get(file.markdownPreviewSourceFileId) ??
        file)
      : file
  const draftVersion = editorDraftVersionByFileId.get(sourceFile.id)
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'Markdown'

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
      ? isUnifiedTabActiveInActiveGroup(state, file.worktreeId, unifiedTabId)
      : state.activeFileId === file.id,
    sourceFileId: sourceFile.id,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    documentVersion: draftVersion ?? `file:${sourceFile.id}`
  }
}

function buildMobileFileTab(
  state: AppState,
  file: AppState['openFiles'][number],
  unifiedTabId?: string
): RuntimeMobileSessionFileTab {
  const title = file.relativePath.split(/[\\/]/).pop() || file.relativePath || 'File'
  const diffSource = isMobileFileDiffSource(file.diffSource) ? file.diffSource : undefined

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
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(state, file.worktreeId, unifiedTabId)
      : state.activeFileId === file.id
  }
}

function isMobileFileDiffSource(
  diffSource: AppState['openFiles'][number]['diffSource']
): diffSource is 'staged' | 'unstaged' {
  return diffSource === 'staged' || diffSource === 'unstaged'
}

function buildMobileBrowserTab(
  state: AppState,
  workspace: NonNullable<AppState['browserTabsByWorktree'][string]>[number],
  unifiedTabId?: string
): RuntimeMobileSessionBrowserTab {
  const pages = state.browserPagesByWorkspace[workspace.id] ?? []
  const activePage = pages.find((page) => page.id === workspace.activePageId) ?? pages[0] ?? null
  const title =
    activePage?.title || workspace.title || activePage?.url || workspace.url || 'Browser'

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
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(state, workspace.worktreeId, unifiedTabId)
      : state.activeBrowserTabIdByWorktree[workspace.worktreeId] === workspace.id
  }
}

function isUnifiedTabActiveInActiveGroup(
  state: AppState,
  worktreeId: string,
  unifiedTabId: string
): boolean {
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  return (
    state.groupsByWorktree[worktreeId]?.some(
      (group) => group.id === activeGroupId && group.activeTabId === unifiedTabId
    ) === true
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
