/* eslint-disable max-lines -- Why: runtime graph sync and mobile session-tab publication share the same injected renderer state and terminal registry. Keeping them together prevents a second store/registry reader from drifting. */
import {
  collectLeafIdsInOrder,
  paneLeafId,
  serializePaneTree
} from '@/components/terminal-pane/layout-serialization'
import { warnTerminalLifecycleAnomaly } from '@/components/terminal-pane/terminal-lifecycle-diagnostics'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { AppState } from '@/store/types'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncWindowGraph
} from '../../../shared/runtime-types'
import { getActiveTabNavOrder } from '../components/tab-bar/group-tab-order'

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
let syncScheduled = false
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
  const pane = manager.getPanes().find((candidate) => paneLeafId(candidate.id) === leafId)
  if (!pane) {
    return false
  }
  manager.setActivePane(pane.id, { focus: true })
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
  syncScheduled = true
  queueMicrotask(() => {
    syncScheduled = false
    void syncRuntimeGraph()
  })
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
  unifiedTabsByWorktree: AppState['unifiedTabsByWorktree']
  tabBarOrderByWorktree: AppState['tabBarOrderByWorktree']
  activeFileId: AppState['activeFileId']
  activeFileIdByWorktree: AppState['activeFileIdByWorktree']
  activeTabId: AppState['activeTabId']
  // Why: these projections still need value-level inspection because the
  // underlying references churn even when the mobile-relevant shape is
  // unchanged (`tabsByWorktree` reallocates on every OSC title frame).
  // Pre-serialize them once.
  tabsProjection: string
  openFilesProjection: string
  editorDraftsProjection: string
}

export function getRuntimeMobileSessionSyncKey(
  state: AppState,
  previousState?: AppState,
  previousKey?: RuntimeMobileSessionSyncKey
): RuntimeMobileSessionSyncKey {
  const canReusePrevious = previousState !== undefined && previousKey !== undefined

  return {
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    groupsByWorktree: state.groupsByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabBarOrderByWorktree: state.tabBarOrderByWorktree,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeTabId: state.activeTabId,
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
    editorDraftsProjection:
      canReusePrevious && state.editorDrafts === previousState.editorDrafts
        ? previousKey.editorDraftsProjection
        : buildRuntimeMobileEditorDraftsProjection(state.editorDrafts)
  }
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
                customTitle: tab.customTitle
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

function buildRuntimeMobileOpenFilesProjection(openFiles: AppState['openFiles']): string {
  return JSON.stringify(
    openFiles.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      mode: file.mode,
      isDirty: file.isDirty,
      isUntitled: file.isUntitled,
      markdownPreviewSourceFileId: file.markdownPreviewSourceFileId
    }))
  )
}

function buildRuntimeMobileEditorDraftsProjection(editorDrafts: AppState['editorDrafts']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(editorDrafts).map(([fileId, content]) => [fileId, stableHashString(content)])
    )
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
    a.unifiedTabsByWorktree === b.unifiedTabsByWorktree &&
    a.tabBarOrderByWorktree === b.tabBarOrderByWorktree &&
    a.activeFileId === b.activeFileId &&
    a.activeFileIdByWorktree === b.activeFileIdByWorktree &&
    a.activeTabId === b.activeTabId &&
    a.tabsProjection === b.tabsProjection &&
    a.openFilesProjection === b.openFilesProjection &&
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
  // Why: sync can run after high-churn terminal/title mutations. Build lookup
  // maps once per sync instead of flattening every worktree's tabs for each
  // registered terminal.
  const terminalTabById = new Map(
    Object.values(state.tabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab])
  )
  const graph: RuntimeSyncWindowGraph = {
    tabs: [],
    leaves: [],
    mobileSessionTabs: buildMobileSessionTabSnapshots(state)
  }

  for (const [tabId, registeredTab] of registeredTabs) {
    const tab = terminalTabById.get(tabId)
    if (!tab) {
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
      title: tab.customTitle ?? tab.title,
      activeLeafId: activePaneId === null ? null : paneLeafId(activePaneId),
      layout: serializePaneTree(root)
    })

    const savedPtyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
    for (const pane of manager?.getPanes() ?? []) {
      const leafId = paneLeafId(pane.id)
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
        title: state.runtimePaneTitlesByTabId[tabId]?.[pane.id] ?? tab.customTitle ?? tab.title
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
  state: AppState
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
    ...state.openFiles.map((file) => file.worktreeId)
  ])

  const snapshots: RuntimeMobileSessionTabsSnapshot[] = []
  for (const worktreeId of worktreeIds) {
    const activeGroupId = state.activeGroupIdByWorktree[worktreeId] ?? null
    const order = getActiveTabNavOrder(state, worktreeId, {
      editorIds: openFileIndexes.idsByWorktree.get(worktreeId) ?? []
    })
    const terminalTabByIdForWorktree = new Map(
      (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
    )
    const tabs: RuntimeMobileSessionSnapshotTab[] = []

    for (const item of order) {
      if (item.type === 'terminal') {
        const terminal = terminalTabByIdForWorktree.get(item.id)
        if (!terminal) {
          continue
        }
        tabs.push(...buildMobileTerminalSurfaceTabs(state, terminal, worktreeId, item.tabId))
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
      tabs
    })
  }

  return snapshots
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

function getRuntimeLeafIdsForTerminal(tabId: string, state: AppState): string[] {
  const registered = registeredTabs.get(tabId)
  const manager = registered?.getManager()
  const liveLeafIds = manager?.getPanes().map((pane) => paneLeafId(pane.id)) ?? []
  if (liveLeafIds.length > 0) {
    return liveLeafIds
  }

  const layout = state.terminalLayoutsByTabId[tabId]
  const persistedLeafIds = collectLeafIdsInOrder(layout?.root)
  if (persistedLeafIds.length > 0) {
    return persistedLeafIds
  }

  // Why: a newly-created terminal tab can be in the store before TerminalPane
  // mounts. Publish its deterministic first-pane surface so mobile does not
  // fill the startup gap from terminal.list.
  return [paneLeafId(1)]
}

function buildMobileTerminalSurfaceTabs(
  state: AppState,
  terminal: NonNullable<AppState['tabsByWorktree'][string]>[number],
  worktreeId: string,
  unifiedTabId?: string
): RuntimeMobileSessionSnapshotTab[] {
  const isDesktopTabActive = unifiedTabId
    ? state.groupsByWorktree[worktreeId]?.some(
        (group) =>
          group.id === state.activeGroupIdByWorktree[worktreeId] &&
          group.activeTabId === unifiedTabId
      ) === true
    : state.activeTabId === terminal.id
  const liveActiveLeafId =
    registeredTabs.get(terminal.id)?.getManager()?.getActivePane()?.id ?? null
  const activeLeafId =
    liveActiveLeafId !== null
      ? paneLeafId(liveActiveLeafId)
      : (state.terminalLayoutsByTabId[terminal.id]?.activeLeafId ?? paneLeafId(1))
  const paneTitles = state.runtimePaneTitlesByTabId[terminal.id] ?? {}
  return getRuntimeLeafIdsForTerminal(terminal.id, state).map((leafId) => {
    const paneId = /^pane:(\d+)$/.exec(leafId)?.[1]
    const paneTitle = paneId ? paneTitles[Number(paneId)] : undefined
    return {
      type: 'terminal' as const,
      id: mobileTerminalSurfaceId(terminal.id, leafId),
      title: paneTitle ?? terminal.customTitle ?? terminal.title ?? 'Terminal',
      parentTabId: terminal.id,
      leafId,
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
      ? state.groupsByWorktree[file.worktreeId]?.some(
          (group) => group.activeTabId === unifiedTabId
        ) === true
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

  return {
    type: 'file',
    id: unifiedTabId ?? file.id,
    title,
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    isDirty: file.isDirty,
    isActive: unifiedTabId
      ? state.groupsByWorktree[file.worktreeId]?.some(
          (group) => group.activeTabId === unifiedTabId
        ) === true
      : state.activeFileId === file.id
  }
}

function stableHashString(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `draft:${value.length}:${(hash >>> 0).toString(16)}`
}
