/* eslint-disable max-lines -- Why: web session-tab sync reconciles terminal,
 * unified-tab, group, and PTY maps atomically so host-published surfaces don't
 * leave the web client in a split-brain tab state. */
import { useEffect } from 'react'
import type { AppState } from '../store'
import { useAppStore } from '../store'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type {
  BrowserPage,
  BrowserWorkspace,
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab,
  TuiAgent
} from '../../../shared/types'
import type { OpenFile } from '../store/slices/editor'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { getRemoteRuntimePtyEnvironmentId, toRemoteRuntimePtyId } from './runtime-terminal-stream'
import { sanitizeTerminalLayoutPaneTitlesForLabels } from '@/lib/terminal-pane-title-sanitization'
import {
  createWebRuntimeSessionTerminal,
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from './web-runtime-session'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  beginWebRuntimeWakeTerminalRespawn,
  clearAllWebRuntimeWakeTerminalRespawn,
  clearWebRuntimeWakeTerminalRespawnForWorktree,
  endWebRuntimeWakeTerminalRespawn,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from './web-runtime-wake-terminal-respawn'

const WEB_SESSION_GROUP_PREFIX = 'web-session-tabs:'

type SessionTabsStreamEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
  | { type: 'end' }

type SessionTabsListAllResult = {
  snapshots: RuntimeMobileSessionTabsResult[]
}

type SnapshotFreshness = {
  publicationEpoch: string
  snapshotVersion: number
}

const latestSessionTabsSnapshotByWorktree = new Map<string, SnapshotFreshness>()
const lastHostTerminalTabCountByWorktree = new Map<string, number>()
const hostSessionTabIdByLocalKey = new Map<string, string>()

type TerminalSurface = RuntimeMobileSessionTerminalClientTab
type ReadyTerminalSurface = RuntimeMobileSessionTerminalClientTab & { status: 'ready' }
type ReadyBrowserSurface = RuntimeMobileSessionBrowserTab & { browserPageId: string }
type ReadyEditorSurface = RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab

type MirroredTerminalTab = {
  tab: TerminalTab
  hostTabId: string
  ptyIds: string[]
  layout: TerminalLayoutSnapshot
}

type MirroredBrowserTab = {
  workspace: BrowserWorkspace
  page: BrowserPage
  remotePageId: string
  unifiedTab: Tab
  hostTabId: string
}

type MirroredEditorTab = {
  file: OpenFile
  unifiedTab: Tab
  hostTabId: string
}

export type WebSessionTabsSyncState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeBrowserTabIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'ptyIdsByTabId'
  | 'remoteBrowserPageHandlesByPageId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'
  | 'sortEpoch'
>

function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

function isSessionTabsListAllResult(value: unknown): value is SessionTabsListAllResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { snapshots?: unknown }).snapshots)
  )
}

function sessionTabsFreshnessKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}:${worktreeId}`
}

function rememberHostTerminalTabCount(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): void {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  const terminalCount = snapshot.tabs.filter((tab) => tab.type === 'terminal').length
  lastHostTerminalTabCountByWorktree.set(key, terminalCount)
}

export function getLastKnownHostTerminalTabCount(
  environmentId: string,
  worktreeId: string
): number {
  return (
    lastHostTerminalTabCountByWorktree.get(sessionTabsFreshnessKey(environmentId, worktreeId)) ?? 0
  )
}

export function shouldApplyWebSessionTabsSnapshot(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): boolean {
  const key = sessionTabsFreshnessKey(environmentId, snapshot.worktree)
  if ((snapshot as { removed?: unknown }).removed === true) {
    // Why: removed worktrees can stop publishing snapshots, so their
    // freshness/mapping entries need explicit cleanup instead of waiting for
    // a later replacement snapshot that may never arrive.
    clearWebSessionTabsTrackingForWorktree(environmentId, snapshot.worktree)
    return true
  }
  rememberHostTerminalTabCount(environmentId, snapshot)
  const current = latestSessionTabsSnapshotByWorktree.get(key)
  if (
    current &&
    current.publicationEpoch === snapshot.publicationEpoch &&
    snapshot.snapshotVersion <= current.snapshotVersion
  ) {
    return false
  }
  latestSessionTabsSnapshotByWorktree.set(key, {
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion
  })
  return true
}

export function shouldBootstrapInitialWebRuntimeTerminal(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedInitialTerminal: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
}): boolean {
  return (
    args.snapshotIsFresh &&
    args.event.type === 'snapshot' &&
    args.event.tabs.length === 0 &&
    args.localTerminalCount === 0 &&
    !args.requestedInitialTerminal &&
    args.activeWorktreeId === args.event.worktree
  )
}

export function shouldRespawnWebRuntimeTerminalAfterWake(args: {
  event: SessionTabsStreamEvent
  activeWorktreeId: string
  requestedRespawnAfterWake: boolean
  snapshotIsFresh: boolean
  localTerminalCount: number
  hasLiveLocalPty: boolean
  skipWakeRespawn?: boolean
}): boolean {
  if (
    !args.snapshotIsFresh ||
    args.requestedRespawnAfterWake ||
    args.skipWakeRespawn === true ||
    args.localTerminalCount === 0 ||
    args.hasLiveLocalPty ||
    (args.event.type !== 'snapshot' && args.event.type !== 'updated')
  ) {
    return false
  }
  if (args.activeWorktreeId !== args.event.worktree) {
    return false
  }
  const hostTerminalTabCount = args.event.tabs.filter((tab) => tab.type === 'terminal').length
  return hostTerminalTabCount === 0
}

export function resetWebSessionTabsSnapshotFreshnessForTests(): void {
  latestSessionTabsSnapshotByWorktree.clear()
  lastHostTerminalTabCountByWorktree.clear()
  hostSessionTabIdByLocalKey.clear()
}

export function _getWebSessionTabsTrackingCountsForTest(): {
  freshness: number
  hostMappings: number
} {
  return {
    freshness: latestSessionTabsSnapshotByWorktree.size,
    hostMappings: hostSessionTabIdByLocalKey.size
  }
}

function clearWebSessionTabsTrackingForWorktree(environmentId: string, worktreeId: string): void {
  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  latestSessionTabsSnapshotByWorktree.delete(key)
  lastHostTerminalTabCountByWorktree.delete(key)
  clearWebRuntimeWakeTerminalRespawnForWorktree(worktreeId)
  const keyPrefix = `${environmentId}:${worktreeId}:`
  for (const key of hostSessionTabIdByLocalKey.keys()) {
    if (key.startsWith(keyPrefix)) {
      hostSessionTabIdByLocalKey.delete(key)
    }
  }
}

export function clearWebSessionTabsTrackingForEnvironment(environmentId: string): void {
  const trimmedEnvironmentId = environmentId.trim()
  if (!trimmedEnvironmentId) {
    return
  }
  const keyPrefix = `${trimmedEnvironmentId}:`
  for (const key of latestSessionTabsSnapshotByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      latestSessionTabsSnapshotByWorktree.delete(key)
    }
  }
  for (const key of lastHostTerminalTabCountByWorktree.keys()) {
    if (key.startsWith(keyPrefix)) {
      lastHostTerminalTabCountByWorktree.delete(key)
    }
  }
  for (const key of hostSessionTabIdByLocalKey.keys()) {
    if (key.startsWith(keyPrefix)) {
      hostSessionTabIdByLocalKey.delete(key)
    }
  }
  clearAllWebRuntimeWakeTerminalRespawn()
}

function hostSessionTabMappingKey(args: {
  environmentId: string
  worktreeId: string
  tabId: string
}): string {
  return `${args.environmentId}:${args.worktreeId}:${args.tabId}`
}

export function resolveHostSessionTabIdForWebSessionTab(
  _state: WebSessionTabsSyncState,
  args: {
    environmentId: string
    worktreeId: string
    tabId: string
  }
): string | null {
  return hostSessionTabIdByLocalKey.get(hostSessionTabMappingKey(args)) ?? null
}

function isReadyTerminalTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyTerminalSurface {
  return tab.type === 'terminal' && tab.status === 'ready' && tab.terminal.trim().length > 0
}

function isTerminalSurfaceTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is TerminalSurface {
  return tab.type === 'terminal'
}

function isReadyBrowserTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyBrowserSurface {
  return tab.type === 'browser' && typeof tab.browserPageId === 'string' && tab.browserPageId !== ''
}

function isReadyEditorTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is ReadyEditorSurface {
  return tab.type === 'markdown' || tab.type === 'file'
}

function localEditorFileId(tab: ReadyEditorSurface): string {
  if (tab.type === 'markdown' && tab.mode === 'markdown-preview') {
    return `markdown-preview::${tab.sourceFilePath}`
  }
  return tab.filePath
}

function editorSourceFileId(tab: ReadyEditorSurface): string | undefined {
  return tab.type === 'markdown' && tab.mode === 'markdown-preview' ? tab.sourceFilePath : undefined
}

function isRuntimeTerminalTabForEnvironment(tab: TerminalTab, environmentId: string): boolean {
  if (!tab.ptyId) {
    return false
  }
  return getRemoteRuntimePtyEnvironmentId(tab.ptyId) === environmentId
}

function isMirroredTerminalSurfaceId(tabId: string): boolean {
  return (
    tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX) ||
    tabId.includes(HOST_TERMINAL_SURFACE_SEPARATOR)
  )
}

function fallbackLayoutForLeafIds(leafIds: readonly string[]): TerminalPaneLayoutNode | null {
  if (leafIds.length === 0) {
    return null
  }
  return leafIds.slice(1).reduce<TerminalPaneLayoutNode>(
    (root, leafId) => ({
      type: 'split',
      direction: 'horizontal',
      first: root,
      second: { type: 'leaf', leafId }
    }),
    { type: 'leaf', leafId: leafIds[0]! }
  )
}

function collectLayoutLeafIds(
  node: TerminalPaneLayoutNode | null | undefined,
  leafIds = new Set<string>()
): Set<string> {
  if (!node) {
    return leafIds
  }
  if (node.type === 'leaf') {
    leafIds.add(node.leafId)
    return leafIds
  }
  collectLayoutLeafIds(node.first, leafIds)
  collectLayoutLeafIds(node.second, leafIds)
  return leafIds
}

function chooseRemoteTerminalLayout(
  surfaces: readonly TerminalSurface[],
  ptyIdsByLeafId: Record<string, string>
): TerminalLayoutSnapshot {
  const leafIds = surfaces.map((surface) => surface.leafId)
  const knownLeafIds = new Set(leafIds)
  const parentLayoutSource = surfaces.find((surface) => surface.parentLayout)
  const parentLayout = parentLayoutSource?.parentLayout
    ? sanitizeTerminalLayoutPaneTitlesForLabels(parentLayoutSource.parentLayout, [
        parentLayoutSource.title
      ])
    : undefined
  const parentLayoutLeafIds = collectLayoutLeafIds(parentLayout?.root)
  const canReuseParentLayout =
    parentLayout?.root &&
    leafIds.every((leafId) => parentLayoutLeafIds.has(leafId)) &&
    [...parentLayoutLeafIds].every((leafId) => knownLeafIds.has(leafId))
  const activeLeafId =
    (parentLayout?.activeLeafId && knownLeafIds.has(parentLayout.activeLeafId)
      ? parentLayout.activeLeafId
      : null) ??
    surfaces.find((surface) => surface.isActive)?.leafId ??
    leafIds[0] ??
    null
  const expandedLeafId =
    parentLayout?.expandedLeafId && knownLeafIds.has(parentLayout.expandedLeafId)
      ? parentLayout.expandedLeafId
      : null
  return {
    root: canReuseParentLayout ? parentLayout.root : fallbackLayoutForLeafIds(leafIds),
    activeLeafId,
    expandedLeafId,
    ptyIdsByLeafId,
    // Why: surface.title is the tab/PTY label ("Terminal 2", agent title,
    // etc.). Restoring it as a pane title makes the web client render a fake
    // title bar above xterm. Only host layout titles are real user pane titles.
    ...(parentLayout?.titlesByLeafId ? { titlesByLeafId: parentLayout.titlesByLeafId } : {})
  }
}

function shouldReplaceTerminalTab(
  tab: TerminalTab,
  environmentId: string,
  nextRemotePtyIds: ReadonlySet<string>,
  nextMirroredTerminalIds: ReadonlySet<string>,
  nextMirroredLaunchAgents: ReadonlySet<TuiAgent>
): boolean {
  if (
    tab.launchAgent &&
    !isMirroredTerminalSurfaceId(tab.id) &&
    nextMirroredLaunchAgents.has(tab.launchAgent)
  ) {
    // Why: paired web agent quick-launch used to create local-only tabs before
    // the host snapshot landed. Retire only the matching agent's stale row.
    return true
  }
  if (isMirroredTerminalSurfaceId(tab.id)) {
    // Why: host session snapshots are authoritative for host-mirrored tabs.
    // Replace old mirrors even when the next surface is still waiting on a
    // stream handle, otherwise paired web keeps stale handles or drops parity.
    return true
  }
  if (tab.pendingActivationSpawn && tab.ptyId === null && nextRemotePtyIds.size > 0) {
    return true
  }
  if (!isRuntimeTerminalTabForEnvironment(tab, environmentId)) {
    return false
  }
  // Why: web-created remote tabs use local UUIDs until the host publishes the
  // corresponding session surface. Only retire them once their PTY is present
  // in the host snapshot, while always pruning prior mirrored surface IDs.
  return (
    tab.ptyId !== null &&
    (nextRemotePtyIds.has(tab.ptyId) ||
      nextMirroredTerminalIds.has(toWebTerminalSurfaceTabId(tab.id)))
  )
}

function buildMirroredTerminalTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  existingById: ReadonlyMap<string, TerminalTab>,
  sortOffset: number,
  now: number
): MirroredTerminalTab[] {
  const groups = new Map<string, TerminalSurface[]>()
  for (const tab of snapshot.tabs.filter(isTerminalSurfaceTab)) {
    const group = groups.get(tab.parentTabId) ?? []
    group.push(tab)
    groups.set(tab.parentTabId, group)
  }

  return [...groups.entries()].map(([parentTabId, surfaces], index) => {
    const localTabId = toWebTerminalSurfaceTabId(parentTabId)
    const activeSurface = surfaces.find((surface) => surface.isActive) ?? surfaces[0]!
    const ptyIdsByLeafId = Object.fromEntries(
      surfaces
        .filter((surface): surface is ReadyTerminalSurface => surface.status === 'ready')
        .map((surface) => [surface.leafId, toRemoteRuntimePtyId(surface.terminal, environmentId)])
    )
    const ptyIds = surfaces
      .map((surface) => ptyIdsByLeafId[surface.leafId]!)
      .filter((ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0)
    const title = activeSurface.title.trim() || surfaces[0]?.title.trim() || 'Terminal'
    const existing =
      existingById.get(localTabId) ??
      existingById.get(parentTabId) ??
      surfaces
        .map((surface) => existingById.get(toWebTerminalSurfaceTabId(surface.id)))
        .find((tab): tab is TerminalTab => Boolean(tab))
    return {
      tab: {
        id: localTabId,
        ptyId: ptyIdsByLeafId[activeSurface.leafId] ?? null,
        worktreeId: snapshot.worktree,
        title,
        defaultTitle: existing?.defaultTitle ?? title,
        customTitle: existing?.customTitle ?? null,
        color: existing?.color ?? null,
        sortOrder: sortOffset + index,
        createdAt: existing?.createdAt ?? now + index,
        ...(activeSurface.launchAgent ? { launchAgent: activeSurface.launchAgent } : {})
      },
      hostTabId: parentTabId,
      ptyIds,
      layout: chooseRemoteTerminalLayout(surfaces, ptyIdsByLeafId)
    }
  })
}

function toMirroredPaneKey(surface: TerminalSurface): string | null {
  if (!isTerminalLeafId(surface.leafId)) {
    return null
  }
  return makePaneKey(toWebTerminalSurfaceTabId(surface.parentTabId), surface.leafId)
}

function remapHostAgentStatus(surface: TerminalSurface): AgentStatusEntry | null {
  if (!surface.agentStatus) {
    return null
  }
  const paneKey = toMirroredPaneKey(surface)
  if (!paneKey) {
    return null
  }
  return {
    ...surface.agentStatus,
    paneKey
  }
}

function isMirroredAgentPaneKeyForTabs(paneKey: string, tabIds: ReadonlySet<string>): boolean {
  const parsed = parsePaneKey(paneKey)
  return parsed !== null && tabIds.has(parsed.tabId)
}

function buildMirroredAgentStatusPatch(
  state: WebSessionTabsSyncState,
  currentTerminalTabs: readonly TerminalTab[],
  terminalSurfaceTabs: readonly TerminalSurface[],
  now: number
): Pick<WebSessionTabsSyncState, 'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'> | null {
  const mirroredTabIds = new Set<string>()
  for (const tab of currentTerminalTabs) {
    if (isWebTerminalSurfaceTabId(tab.id)) {
      mirroredTabIds.add(tab.id)
    }
  }
  for (const surface of terminalSurfaceTabs) {
    mirroredTabIds.add(toWebTerminalSurfaceTabId(surface.parentTabId))
  }

  if (mirroredTabIds.size === 0) {
    return null
  }

  const nextByPaneKey = new Map<string, AgentStatusEntry>()
  for (const surface of terminalSurfaceTabs) {
    const entry = remapHostAgentStatus(surface)
    if (!entry) {
      continue
    }
    const existing = state.agentStatusByPaneKey[entry.paneKey]
    // Why: active web streams can report a fresher OSC 9999 status for the same
    // mirrored pane before the next host snapshot arrives. Do not rewind that
    // row with an older host publication.
    nextByPaneKey.set(
      entry.paneKey,
      existing && existing.updatedAt > entry.updatedAt ? existing : entry
    )
  }

  let nextAgentStatusByPaneKey = state.agentStatusByPaneKey
  let changed = false
  let sortRelevantChange = false

  for (const paneKey of Object.keys(state.agentStatusByPaneKey)) {
    if (!isMirroredAgentPaneKeyForTabs(paneKey, mirroredTabIds)) {
      continue
    }
    if (nextByPaneKey.has(paneKey)) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = { ...state.agentStatusByPaneKey }
    }
    delete nextAgentStatusByPaneKey[paneKey]
    changed = true
    sortRelevantChange = true
  }

  for (const [paneKey, entry] of nextByPaneKey) {
    const existing = nextAgentStatusByPaneKey[paneKey]
    if (agentStatusEntryEqual(existing, entry)) {
      continue
    }
    if (nextAgentStatusByPaneKey === state.agentStatusByPaneKey) {
      nextAgentStatusByPaneKey = { ...state.agentStatusByPaneKey }
    }
    nextAgentStatusByPaneKey[paneKey] = entry
    changed = true
    sortRelevantChange =
      sortRelevantChange ||
      !existing ||
      existing.state !== entry.state ||
      !isAgentStatusFresh(existing, now)
  }

  if (!changed) {
    return null
  }

  return {
    agentStatusByPaneKey: nextAgentStatusByPaneKey,
    agentStatusEpoch: sortRelevantChange ? state.agentStatusEpoch + 1 : state.agentStatusEpoch,
    sortEpoch: sortRelevantChange ? state.sortEpoch + 1 : state.sortEpoch
  }
}

function buildTerminalUnifiedTab(tab: TerminalTab, groupId: string): Tab {
  return {
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    contentType: 'terminal',
    label: tab.title,
    ...(tab.generatedTitle?.trim() ? { generatedLabel: tab.generatedTitle.trim() } : {}),
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned: false
  }
}

function buildBrowserUnifiedTab(tab: BrowserWorkspace, unifiedTabId: string, groupId: string): Tab {
  return {
    id: unifiedTabId,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    contentType: 'browser',
    label: tab.title,
    customLabel: null,
    color: null,
    sortOrder: tab.createdAt,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned: false
  }
}

function buildEditorUnifiedTab(
  file: OpenFile,
  hostTabId: string,
  label: string,
  groupId: string,
  sortOrder: number,
  createdAt: number
): Tab {
  return {
    id: hostTabId,
    entityId: file.id,
    groupId,
    worktreeId: file.worktreeId,
    contentType: 'editor',
    label,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt,
    isPreview: false,
    isPinned: false
  }
}

function findExistingEditorUnifiedTab(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  fileId: string,
  hostTabId: string
): Tab | null {
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'editor' && (tab.id === hostTabId || tab.entityId === fileId)
    ) ?? null
  )
}

function buildMirroredEditorTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  state: WebSessionTabsSyncState,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number
): MirroredEditorTab[] {
  return snapshot.tabs.filter(isReadyEditorTab).map((tab, index) => {
    const fileId = localEditorFileId(tab)
    const existingFile = state.openFiles.find(
      (file) => file.worktreeId === snapshot.worktree && file.id === fileId
    )
    const existingUnifiedTab = findExistingEditorUnifiedTab(
      state,
      snapshot.worktree,
      fileId,
      tab.id
    )
    const sourceFileId = editorSourceFileId(tab)
    const groupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    const file: OpenFile = {
      ...existingFile,
      id: fileId,
      filePath: tab.filePath,
      relativePath: tab.relativePath,
      worktreeId: snapshot.worktree,
      language: tab.language,
      isDirty: tab.isDirty,
      runtimeEnvironmentId: environmentId,
      mode: tab.type === 'markdown' ? tab.mode : 'edit',
      markdownPreviewSourceFileId: sourceFileId
    }
    return {
      file,
      hostTabId: tab.id,
      unifiedTab: buildEditorUnifiedTab(
        file,
        tab.id,
        tab.title.trim() || tab.relativePath || 'File',
        groupId,
        sortOffset + index,
        existingUnifiedTab?.createdAt ?? now + sortOffset + index
      )
    }
  })
}

function findBrowserWorkspaceForRemotePage(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  environmentId: string,
  remotePageId: string
): { workspace: BrowserWorkspace; page: BrowserPage; unifiedTab: Tab | null } | null {
  const workspaces = state.browserTabsByWorktree[worktreeId] ?? []
  for (const workspace of workspaces) {
    const pages = state.browserPagesByWorkspace[workspace.id] ?? []
    for (const page of pages) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle?.environmentId === environmentId && handle.remotePageId === remotePageId) {
        return {
          workspace,
          page,
          unifiedTab:
            (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
            ) ?? null
        }
      }
    }
  }
  return null
}

function browserWorkspaceHasRemoteEnvironmentPage(
  state: WebSessionTabsSyncState,
  workspace: BrowserWorkspace,
  environmentId: string
): boolean {
  return (state.browserPagesByWorkspace[workspace.id] ?? []).some(
    (page) => state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId === environmentId
  )
}

function buildMirroredBrowserTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  state: WebSessionTabsSyncState,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number
): MirroredBrowserTab[] {
  return snapshot.tabs.filter(isReadyBrowserTab).map((tab, index) => {
    const existing = findBrowserWorkspaceForRemotePage(
      state,
      snapshot.worktree,
      environmentId,
      tab.browserPageId
    )
    const workspaceId = existing?.workspace.id ?? tab.browserWorkspaceId
    const pageId = existing?.page.id ?? tab.browserPageId
    const createdAt = existing?.page.createdAt ?? now + sortOffset + index
    const groupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    const title = tab.title.trim() || 'Browser'
    const page: BrowserPage = {
      id: pageId,
      workspaceId,
      worktreeId: snapshot.worktree,
      url: tab.url,
      title,
      loading: tab.loading,
      faviconUrl: existing?.page.faviconUrl ?? null,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      loadError: null,
      createdAt,
      viewportPresetId: existing?.page.viewportPresetId ?? null
    }
    const workspace: BrowserWorkspace = {
      id: workspaceId,
      worktreeId: snapshot.worktree,
      label: existing?.workspace.label,
      sessionProfileId: existing?.workspace.sessionProfileId ?? null,
      activePageId: page.id,
      pageIds: [page.id],
      url: page.url,
      title: page.title,
      loading: page.loading,
      faviconUrl: page.faviconUrl,
      canGoBack: page.canGoBack,
      canGoForward: page.canGoForward,
      loadError: page.loadError,
      createdAt
    }
    return {
      workspace,
      page,
      remotePageId: tab.browserPageId,
      unifiedTab: buildBrowserUnifiedTab(workspace, existing?.unifiedTab?.id ?? tab.id, groupId),
      hostTabId: tab.id
    }
  })
}

function chooseTargetGroupId(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): string {
  const groups = state.groupsByWorktree[snapshot.worktree] ?? []
  const layoutGroupIds = collectLayoutGroupIds(state.layoutByWorktree[snapshot.worktree])
  const inRenderedLayout = (groupId: string | null | undefined): boolean =>
    Boolean(groupId && (layoutGroupIds.size === 0 || layoutGroupIds.has(groupId)))
  const preferred =
    groups.find((group) => group.id === snapshot.activeGroupId && inRenderedLayout(group.id)) ??
    groups.find(
      (group) =>
        group.id === state.activeGroupIdByWorktree[snapshot.worktree] && inRenderedLayout(group.id)
    ) ??
    groups.find((group) => inRenderedLayout(group.id))
  // Why: host snapshots can reference desktop-only group ids. The web layout's
  // rendered group is the only safe CSS anchor target for mirrored panes.
  const firstRenderedLayoutGroupId = layoutGroupIds.values().next().value as string | undefined
  return (
    preferred?.id ??
    firstRenderedLayoutGroupId ??
    snapshot.activeGroupId ??
    `${WEB_SESSION_GROUP_PREFIX}${snapshot.worktree}`
  )
}

function collectLayoutGroupIds(layout: TabGroupLayoutNode | undefined): Set<string> {
  const result = new Set<string>()
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.add(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

function buildHostGroupIdByTabId(
  hostGroups: readonly RuntimeMobileSessionTabGroup[] | undefined
): Map<string, string> {
  const result = new Map<string, string>()
  for (const group of hostGroups ?? []) {
    for (const tabId of group.tabOrder) {
      result.set(tabId, group.id)
    }
    if (group.activeTabId) {
      result.set(group.activeTabId, group.id)
    }
  }
  return result
}

function pruneTabGroupLayout(
  layout: TabGroupLayoutNode | null | undefined,
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

function appendTabGroupLayout(
  first: TabGroupLayoutNode | null,
  second: TabGroupLayoutNode | null
): TabGroupLayoutNode | null {
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return {
    type: 'split',
    direction: 'horizontal',
    first,
    second
  }
}

function tabGroupLayoutEqual(
  a: TabGroupLayoutNode | null | undefined,
  b: TabGroupLayoutNode | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  if (a.type !== b.type) {
    return false
  }
  if (a.type === 'leaf') {
    return b.type === 'leaf' && a.groupId === b.groupId
  }
  return (
    b.type === 'split' &&
    a.direction === b.direction &&
    a.ratio === b.ratio &&
    tabGroupLayoutEqual(a.first, b.first) &&
    tabGroupLayoutEqual(a.second, b.second)
  )
}

function mapHostRecentTabIds(
  recentTabIds: readonly string[] | undefined,
  hostToLocalTabId: ReadonlyMap<string, string>,
  tabOrder: readonly string[]
): string[] {
  if (!recentTabIds || recentTabIds.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  return sanitizeRecentTabIds(
    recentTabIds.map((tabId) => hostToLocalTabId.get(tabId) ?? '').filter(Boolean),
    [...valid]
  )
}

function buildHostToLocalTabIdMap({
  terminalSurfaces,
  terminalTabs,
  browserTabs,
  editorTabs
}: {
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
}): Map<string, string> {
  const hostToLocal = new Map<string, string>()
  const terminalIds = new Set(terminalTabs.map((tab) => tab.id))
  for (const surface of terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (terminalIds.has(localId)) {
      hostToLocal.set(surface.parentTabId, localId)
      hostToLocal.set(surface.id, localId)
    }
  }
  for (const entry of browserTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
    hostToLocal.set(entry.unifiedTab.id, entry.unifiedTab.id)
  }
  for (const entry of editorTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  return hostToLocal
}

function updateHostSessionTabIdMappings(args: {
  environmentId: string
  worktreeId: string
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
}): void {
  const keyPrefix = `${args.environmentId}:${args.worktreeId}:`
  for (const key of hostSessionTabIdByLocalKey.keys()) {
    if (key.startsWith(keyPrefix)) {
      hostSessionTabIdByLocalKey.delete(key)
    }
  }

  const mirroredTerminalIds = new Set(args.terminalTabs.map((tab) => tab.id))
  for (const surface of args.terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (mirroredTerminalIds.has(localId)) {
      hostSessionTabIdByLocalKey.set(
        hostSessionTabMappingKey({ ...args, tabId: localId }),
        surface.parentTabId
      )
    }
  }
  for (const entry of args.browserTabs) {
    hostSessionTabIdByLocalKey.set(
      hostSessionTabMappingKey({ ...args, tabId: entry.unifiedTab.id }),
      entry.hostTabId
    )
  }
  for (const entry of args.editorTabs) {
    hostSessionTabIdByLocalKey.set(
      hostSessionTabMappingKey({ ...args, tabId: entry.unifiedTab.id }),
      entry.hostTabId
    )
  }
}

function buildMirroredHostGroups({
  currentGroups,
  hostGroups,
  hostToLocalTabId,
  mirroredUnifiedIds,
  nextActiveUnifiedTabId,
  validUnifiedTabIds,
  worktreeId
}: {
  currentGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
  hostToLocalTabId: ReadonlyMap<string, string>
  mirroredUnifiedIds: ReadonlySet<string>
  nextActiveUnifiedTabId: string | null
  validUnifiedTabIds: ReadonlySet<string>
  worktreeId: string
}): TabGroup[] | null {
  const strippedGroups = currentGroups.map((group) => {
    const tabOrder = group.tabOrder.filter(
      (tabId) => validUnifiedTabIds.has(tabId) && !mirroredUnifiedIds.has(tabId)
    )
    return {
      ...group,
      tabOrder,
      recentTabIds: sanitizeRecentTabIds(group.recentTabIds, tabOrder)
    }
  })
  const groupsById = new Map(strippedGroups.map((group) => [group.id, group]))
  const orderedGroups: TabGroup[] = []
  const seen = new Set<string>()

  for (const hostGroup of hostGroups) {
    const existing = groupsById.get(hostGroup.id)
    const localHostOrder = hostGroup.tabOrder
      .map((tabId) => hostToLocalTabId.get(tabId))
      .filter((tabId): tabId is string => tabId !== undefined && validUnifiedTabIds.has(tabId))
    const tabOrder = [
      ...(existing?.tabOrder.filter((tabId) => !localHostOrder.includes(tabId)) ?? []),
      ...localHostOrder
    ]
    if (tabOrder.length === 0) {
      continue
    }
    const activeFromHost =
      hostGroup.activeTabId !== null ? (hostToLocalTabId.get(hostGroup.activeTabId) ?? null) : null
    const activeTabId =
      nextActiveUnifiedTabId && tabOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : activeFromHost && tabOrder.includes(activeFromHost)
          ? activeFromHost
          : existing?.activeTabId && tabOrder.includes(existing.activeTabId)
            ? existing.activeTabId
            : (tabOrder[0] ?? null)
    orderedGroups.push({
      id: hostGroup.id,
      worktreeId,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(
            mapHostRecentTabIds(hostGroup.recentTabIds, hostToLocalTabId, tabOrder),
            activeTabId
          )
        : []
    })
    seen.add(hostGroup.id)
  }

  for (const group of strippedGroups) {
    if (!seen.has(group.id) && group.tabOrder.length > 0) {
      orderedGroups.push(group)
    }
  }

  return orderedGroups.length > 0 ? orderedGroups : null
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

function sameAgentStateHistory(
  a: AgentStatusEntry['stateHistory'],
  b: AgentStatusEntry['stateHistory']
): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every(
    (entry, index) =>
      entry.state === b[index]?.state &&
      entry.prompt === b[index]?.prompt &&
      entry.startedAt === b[index]?.startedAt &&
      entry.interrupted === b[index]?.interrupted
  )
}

function agentStatusEntryEqual(a: AgentStatusEntry | undefined, b: AgentStatusEntry): boolean {
  if (!a) {
    return false
  }
  return (
    a.state === b.state &&
    a.prompt === b.prompt &&
    a.updatedAt === b.updatedAt &&
    a.stateStartedAt === b.stateStartedAt &&
    a.agentType === b.agentType &&
    a.paneKey === b.paneKey &&
    a.terminalTitle === b.terminalTitle &&
    a.toolName === b.toolName &&
    a.toolInput === b.toolInput &&
    a.lastAssistantMessage === b.lastAssistantMessage &&
    a.interrupted === b.interrupted &&
    sameAgentStateHistory(a.stateHistory, b.stateHistory)
  )
}

function isAgentStatusFresh(entry: Pick<AgentStatusEntry, 'updatedAt'>, now: number): boolean {
  return now - entry.updatedAt <= AGENT_STATUS_STALE_AFTER_MS
}

function sameStringRecord(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined
): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && left[key] === right[key]
    )
  )
}

function terminalLayoutNodeEqual(
  a: TerminalPaneLayoutNode | null | undefined,
  b: TerminalPaneLayoutNode | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  if (a.type !== b.type) {
    return false
  }
  if (a.type === 'leaf') {
    return b.type === 'leaf' && a.leafId === b.leafId
  }
  return (
    b.type === 'split' &&
    a.direction === b.direction &&
    a.ratio === b.ratio &&
    terminalLayoutNodeEqual(a.first, b.first) &&
    terminalLayoutNodeEqual(a.second, b.second)
  )
}

function terminalLayoutEqual(
  a: TerminalLayoutSnapshot | undefined,
  b: TerminalLayoutSnapshot
): boolean {
  return (
    terminalLayoutNodeEqual(a?.root, b.root) &&
    (a?.activeLeafId ?? null) === b.activeLeafId &&
    (a?.expandedLeafId ?? null) === b.expandedLeafId &&
    sameStringRecord(a?.ptyIdsByLeafId, b.ptyIdsByLeafId) &&
    sameStringRecord(a?.buffersByLeafId, b.buffersByLeafId) &&
    sameStringRecord(a?.scrollbackRefsByLeafId, b.scrollbackRefsByLeafId) &&
    sameStringRecord(a?.titlesByLeafId, b.titlesByLeafId)
  )
}

function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.reverse()
}

function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  return [...base.filter((id) => id !== tabId), tabId]
}

function withWorktreeEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T | null,
  equal: (a: T | undefined, b: T | null) => boolean
): Record<string, T> {
  if (equal(record[key], value)) {
    return record
  }
  const next = { ...record }
  if (value === null) {
    delete next[key]
  } else {
    next[key] = value
  }
  return next
}

function terminalTabEqual(a: TerminalTab, b: TerminalTab): boolean {
  return (
    a.id === b.id &&
    a.ptyId === b.ptyId &&
    a.worktreeId === b.worktreeId &&
    a.title === b.title &&
    a.defaultTitle === b.defaultTitle &&
    a.generatedTitle === b.generatedTitle &&
    a.customTitle === b.customTitle &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.generation === b.generation &&
    a.shellOverride === b.shellOverride &&
    a.launchAgent === b.launchAgent &&
    a.pendingActivationSpawn === b.pendingActivationSpawn
  )
}

function sameTerminalTabs(
  a: readonly TerminalTab[] | undefined,
  b: readonly TerminalTab[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => terminalTabEqual(tab, right[index]!))
}

function browserPageEqual(a: BrowserPage, b: BrowserPage): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.worktreeId === b.worktreeId &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.faviconUrl === b.faviconUrl &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.loadError?.code === b.loadError?.code &&
    a.loadError?.description === b.loadError?.description &&
    a.loadError?.validatedUrl === b.loadError?.validatedUrl &&
    a.createdAt === b.createdAt &&
    a.viewportPresetId === b.viewportPresetId
  )
}

function sameBrowserPages(
  a: readonly BrowserPage[] | undefined,
  b: readonly BrowserPage[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((page, index) => browserPageEqual(page, right[index]!))
}

function browserWorkspaceEqual(a: BrowserWorkspace, b: BrowserWorkspace): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.label === b.label &&
    a.sessionProfileId === b.sessionProfileId &&
    a.activePageId === b.activePageId &&
    sameStringArray(a.pageIds ?? [], b.pageIds ?? []) &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.faviconUrl === b.faviconUrl &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.loadError?.code === b.loadError?.code &&
    a.loadError?.description === b.loadError?.description &&
    a.loadError?.validatedUrl === b.loadError?.validatedUrl &&
    a.createdAt === b.createdAt
  )
}

function sameBrowserTabs(
  a: readonly BrowserWorkspace[] | undefined,
  b: readonly BrowserWorkspace[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => browserWorkspaceEqual(tab, right[index]!))
}

function openFileEqual(a: OpenFile, b: OpenFile): boolean {
  return (
    a.id === b.id &&
    a.filePath === b.filePath &&
    a.relativePath === b.relativePath &&
    a.worktreeId === b.worktreeId &&
    a.language === b.language &&
    a.isDirty === b.isDirty &&
    a.runtimeEnvironmentId === b.runtimeEnvironmentId &&
    a.markdownPreviewSourceFileId === b.markdownPreviewSourceFileId &&
    a.markdownPreviewAnchor === b.markdownPreviewAnchor &&
    a.isPreview === b.isPreview &&
    a.isUntitled === b.isUntitled &&
    a.deleteUntouchedOnClose === b.deleteUntouchedOnClose &&
    a.externalMutation === b.externalMutation &&
    a.mode === b.mode
  )
}

function sameOpenFiles(a: readonly OpenFile[], b: readonly OpenFile[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((file, index) => openFileEqual(file, b[index]!))
}

function tabEqual(a: Tab, b: Tab): boolean {
  return (
    a.id === b.id &&
    a.entityId === b.entityId &&
    a.groupId === b.groupId &&
    a.worktreeId === b.worktreeId &&
    a.contentType === b.contentType &&
    a.label === b.label &&
    a.customLabel === b.customLabel &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.isPreview === b.isPreview &&
    a.isPinned === b.isPinned
  )
}

function sameUnifiedTabs(a: readonly Tab[] | undefined, b: readonly Tab[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => tabEqual(tab, right[index]!))
}

function groupEqual(a: TabGroup, b: TabGroup): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.activeTabId === b.activeTabId &&
    sameStringArray(a.tabOrder, b.tabOrder) &&
    sameStringArray(a.recentTabIds ?? [], b.recentTabIds ?? [])
  )
}

function sameGroups(a: readonly TabGroup[] | undefined, b: readonly TabGroup[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((group, index) => groupEqual(group, right[index]!))
}

function toVisibleTabType(tab: Tab): WebSessionTabsSyncState['activeTabType'] {
  if (tab.contentType === 'browser' || tab.contentType === 'terminal') {
    return tab.contentType
  }
  return 'editor'
}

export function applyWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const worktreeId = snapshot.worktree
  const currentTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const existingTerminalById = new Map(currentTerminalTabs.map((tab) => [tab.id, tab]))
  const terminalSurfaceTabs = snapshot.tabs.filter(isTerminalSurfaceTab)
  const readyTerminalTabs = terminalSurfaceTabs.filter(isReadyTerminalTab)
  const nextRemotePtyIds = new Set(
    readyTerminalTabs.map((tab) => toRemoteRuntimePtyId(tab.terminal, environmentId))
  )
  const nextMirroredTerminalIds = new Set(
    terminalSurfaceTabs.map((tab) => toWebTerminalSurfaceTabId(tab.parentTabId))
  )
  const nextMirroredLaunchAgents = new Set(
    terminalSurfaceTabs
      .map((tab) => tab.launchAgent)
      .filter((agent): agent is TuiAgent => Boolean(agent))
  )
  const retainedTerminalTabs = currentTerminalTabs.filter(
    (tab) =>
      !shouldReplaceTerminalTab(
        tab,
        environmentId,
        nextRemotePtyIds,
        nextMirroredTerminalIds,
        nextMirroredLaunchAgents
      )
  )
  const mirroredTerminalTabs = buildMirroredTerminalTabs(
    snapshot,
    environmentId,
    existingTerminalById,
    retainedTerminalTabs.length,
    now
  )
  const mirroredTerminalTabEntries = mirroredTerminalTabs.map((entry) => entry.tab)
  const retainedTerminalIds = new Set(retainedTerminalTabs.map((tab) => tab.id))
  const nextTerminalTabs =
    retainedTerminalTabs.length + mirroredTerminalTabEntries.length > 0
      ? [...retainedTerminalTabs, ...mirroredTerminalTabEntries]
      : null
  const mirroredTerminalIds = new Set(mirroredTerminalTabEntries.map((tab) => tab.id))
  const removedTerminalIds = new Set(
    currentTerminalTabs.filter((tab) => !retainedTerminalIds.has(tab.id)).map((tab) => tab.id)
  )

  const targetGroupId = chooseTargetGroupId(state, snapshot)
  const hostGroupIdByTabId = buildHostGroupIdByTabId(snapshot.tabGroups)
  const readyBrowserTabs = snapshot.tabs.filter(isReadyBrowserTab)
  const nextRemoteBrowserPageIds = new Set(readyBrowserTabs.map((tab) => tab.browserPageId))
  const mirroredBrowserTabs = buildMirroredBrowserTabs(
    snapshot,
    environmentId,
    state,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length,
    now
  )
  const mirroredBrowserWorkspaceIds = new Set(
    mirroredBrowserTabs.map((entry) => entry.workspace.id)
  )
  const currentBrowserTabs = state.browserTabsByWorktree[worktreeId] ?? []
  const removedBrowserWorkspaceIds = new Set(
    currentBrowserTabs
      .filter((tab) => {
        if (mirroredBrowserWorkspaceIds.has(tab.id)) {
          return true
        }
        if (!browserWorkspaceHasRemoteEnvironmentPage(state, tab, environmentId)) {
          return false
        }
        return !(state.browserPagesByWorkspace[tab.id] ?? []).some((page) => {
          const handle = state.remoteBrowserPageHandlesByPageId[page.id]
          return (
            handle?.environmentId === environmentId &&
            nextRemoteBrowserPageIds.has(handle.remotePageId)
          )
        })
      })
      .map((tab) => tab.id)
  )
  const retainedBrowserTabs = currentBrowserTabs.filter(
    (tab) => !removedBrowserWorkspaceIds.has(tab.id)
  )
  const nextBrowserTabs =
    retainedBrowserTabs.length + mirroredBrowserTabs.length > 0
      ? [...retainedBrowserTabs, ...mirroredBrowserTabs.map((entry) => entry.workspace)]
      : null
  const readyEditorTabs = snapshot.tabs.filter(isReadyEditorTab)
  const mirroredEditorTabs = buildMirroredEditorTabs(
    snapshot,
    environmentId,
    state,
    hostGroupIdByTabId,
    targetGroupId,
    mirroredTerminalTabEntries.length + mirroredBrowserTabs.length,
    now
  )
  const mirroredEditorFileIds = new Set(mirroredEditorTabs.map((entry) => entry.file.id))
  const mirroredEditorHostTabIds = new Set(mirroredEditorTabs.map((entry) => entry.hostTabId))
  const removedEditorFileIds = new Set(
    state.openFiles
      .filter(
        (file) =>
          file.worktreeId === worktreeId &&
          file.runtimeEnvironmentId === environmentId &&
          (file.mode === 'edit' || file.mode === 'markdown-preview') &&
          !mirroredEditorFileIds.has(file.id)
      )
      .map((file) => file.id)
  )
  const nextOpenFiles = (() => {
    const retained = state.openFiles.filter(
      (file) =>
        !(
          file.worktreeId === worktreeId &&
          file.runtimeEnvironmentId === environmentId &&
          (removedEditorFileIds.has(file.id) || mirroredEditorFileIds.has(file.id))
        )
    )
    const next = [...retained, ...mirroredEditorTabs.map((entry) => entry.file)]
    return sameOpenFiles(state.openFiles, next) ? state.openFiles : next
  })()
  const currentUnifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const retainedUnifiedTabs = currentUnifiedTabs.filter((tab) => {
    if (tab.contentType === 'browser') {
      return (
        !removedBrowserWorkspaceIds.has(tab.entityId) &&
        !mirroredBrowserWorkspaceIds.has(tab.entityId)
      )
    }
    if (tab.contentType === 'editor') {
      return (
        !removedEditorFileIds.has(tab.entityId) &&
        !mirroredEditorFileIds.has(tab.entityId) &&
        !mirroredEditorHostTabIds.has(tab.id)
      )
    }
    if (tab.contentType !== 'terminal') {
      return true
    }
    if (removedTerminalIds.has(tab.entityId) || removedTerminalIds.has(tab.id)) {
      return false
    }
    return !mirroredTerminalIds.has(tab.entityId) && !mirroredTerminalIds.has(tab.id)
  })
  const mirroredTerminalUnifiedTabs = mirroredTerminalTabs.map((entry) =>
    buildTerminalUnifiedTab(entry.tab, hostGroupIdByTabId.get(entry.hostTabId) ?? targetGroupId)
  )
  const mirroredBrowserUnifiedTabs = mirroredBrowserTabs.map((entry) => entry.unifiedTab)
  const mirroredEditorUnifiedTabs = mirroredEditorTabs.map((entry) => entry.unifiedTab)
  const mirroredUnifiedTabs = [
    ...mirroredTerminalUnifiedTabs,
    ...mirroredBrowserUnifiedTabs,
    ...mirroredEditorUnifiedTabs
  ]
  const nextUnifiedTabs =
    retainedUnifiedTabs.length + mirroredUnifiedTabs.length > 0
      ? [...retainedUnifiedTabs, ...mirroredUnifiedTabs]
      : null
  const validUnifiedTabIds = new Set(nextUnifiedTabs?.map((tab) => tab.id) ?? [])
  const activeHostTerminalId =
    terminalSurfaceTabs.find((tab) => tab.id === snapshot.activeTabId)?.id ??
    terminalSurfaceTabs.find((tab) => tab.isActive)?.id ??
    null
  const activeHostTerminalParentId =
    terminalSurfaceTabs.find((tab) => tab.id === activeHostTerminalId)?.parentTabId ??
    terminalSurfaceTabs.find((tab) => tab.isActive)?.parentTabId ??
    null
  const activeMirroredTerminalId = activeHostTerminalId
    ? toWebTerminalSurfaceTabId(activeHostTerminalParentId ?? activeHostTerminalId)
    : null
  const activeHostBrowser =
    readyBrowserTabs.find((tab) => tab.id === snapshot.activeTabId) ??
    readyBrowserTabs.find((tab) => tab.isActive) ??
    null
  const activeMirroredBrowser = activeHostBrowser
    ? (mirroredBrowserTabs.find(
        (entry) => entry.remotePageId === activeHostBrowser.browserPageId
      ) ?? null)
    : null
  const activeMirroredBrowserTabId = activeMirroredBrowser?.unifiedTab.id ?? null
  const activeMirroredBrowserWorkspaceId = activeMirroredBrowser?.workspace.id ?? null
  const activeHostEditor =
    readyEditorTabs.find((tab) => tab.id === snapshot.activeTabId) ??
    readyEditorTabs.find((tab) => tab.isActive) ??
    null
  const activeMirroredEditor = activeHostEditor
    ? (mirroredEditorTabs.find((entry) => entry.hostTabId === activeHostEditor.id) ?? null)
    : null
  const activeMirroredEditorFileId = activeMirroredEditor?.file.id ?? null
  const activeMirroredEditorTabId = activeMirroredEditor?.unifiedTab.id ?? null
  const currentActiveTerminalStillExists =
    state.activeTabIdByWorktree[worktreeId] &&
    (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabIdByWorktree[worktreeId])
      ? state.activeTabIdByWorktree[worktreeId]
      : null
  const nextActiveTerminalId =
    snapshot.activeTabType === 'terminal'
      ? (activeMirroredTerminalId ??
        mirroredTerminalTabEntries[0]?.id ??
        currentActiveTerminalStillExists)
      : (currentActiveTerminalStillExists ?? mirroredTerminalTabEntries[0]?.id ?? null)
  const currentActiveBrowserStillExists =
    state.activeBrowserTabIdByWorktree[worktreeId] &&
    (nextBrowserTabs ?? []).some((tab) => tab.id === state.activeBrowserTabIdByWorktree[worktreeId])
      ? state.activeBrowserTabIdByWorktree[worktreeId]
      : null
  const nextActiveBrowserWorkspaceId =
    snapshot.activeTabType === 'browser'
      ? (activeMirroredBrowserWorkspaceId ??
        mirroredBrowserTabs[0]?.workspace.id ??
        currentActiveBrowserStillExists)
      : (currentActiveBrowserStillExists ?? mirroredBrowserTabs[0]?.workspace.id ?? null)
  const currentActiveEditorStillExists =
    state.activeFileIdByWorktree[worktreeId] &&
    nextOpenFiles.some(
      (file) =>
        file.worktreeId === worktreeId && file.id === state.activeFileIdByWorktree[worktreeId]
    )
      ? state.activeFileIdByWorktree[worktreeId]
      : null
  const nextActiveEditorFileId =
    snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? (activeMirroredEditorFileId ??
        mirroredEditorTabs[0]?.file.id ??
        currentActiveEditorStillExists)
      : (currentActiveEditorStillExists ?? mirroredEditorTabs[0]?.file.id ?? null)
  const nextActiveUnifiedTabId =
    snapshot.activeTabType === 'browser'
      ? (activeMirroredBrowserTabId ??
        mirroredBrowserTabs[0]?.unifiedTab.id ??
        state.activeTabIdByWorktree[worktreeId] ??
        nextActiveTerminalId)
      : snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
        ? (activeMirroredEditorTabId ??
          mirroredEditorTabs[0]?.unifiedTab.id ??
          state.activeTabIdByWorktree[worktreeId] ??
          nextActiveTerminalId)
        : nextActiveTerminalId
  const mirroredUnifiedIds = new Set(mirroredUnifiedTabs.map((tab) => tab.id))
  const hostToLocalTabId = buildHostToLocalTabIdMap({
    terminalSurfaces: terminalSurfaceTabs,
    terminalTabs: mirroredTerminalTabEntries,
    browserTabs: mirroredBrowserTabs,
    editorTabs: mirroredEditorTabs
  })
  updateHostSessionTabIdMappings({
    environmentId,
    worktreeId,
    terminalSurfaces: terminalSurfaceTabs,
    terminalTabs: mirroredTerminalTabEntries,
    browserTabs: mirroredBrowserTabs,
    editorTabs: mirroredEditorTabs
  })

  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  const nextGroups = (() => {
    if (!nextUnifiedTabs || nextUnifiedTabs.length === 0) {
      return null
    }
    if (snapshot.tabGroups && snapshot.tabGroups.length > 0) {
      return buildMirroredHostGroups({
        currentGroups,
        hostGroups: snapshot.tabGroups,
        hostToLocalTabId,
        mirroredUnifiedIds,
        nextActiveUnifiedTabId,
        validUnifiedTabIds,
        worktreeId
      })
    }
    const strippedGroups = currentGroups.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter(
        (tabId) => validUnifiedTabIds.has(tabId) && !mirroredUnifiedIds.has(tabId)
      ),
      recentTabIds: sanitizeRecentTabIds(
        group.recentTabIds,
        group.tabOrder.filter(
          (tabId) => validUnifiedTabIds.has(tabId) && !mirroredUnifiedIds.has(tabId)
        )
      )
    }))
    const target = strippedGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const targetOrder = [
      ...target.tabOrder.filter((tabId) => validUnifiedTabIds.has(tabId)),
      ...mirroredUnifiedTabs.map((tab) => tab.id)
    ]
    const targetActiveTabId =
      nextActiveUnifiedTabId && targetOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : target.activeTabId && targetOrder.includes(target.activeTabId)
          ? target.activeTabId
          : (targetOrder[0] ?? null)
    const updatedTarget: TabGroup = {
      ...target,
      worktreeId,
      tabOrder: targetOrder,
      activeTabId: targetActiveTabId,
      recentTabIds: targetActiveTabId
        ? pushRecentTabId(sanitizeRecentTabIds(target.recentTabIds, targetOrder), targetActiveTabId)
        : []
    }
    const merged = strippedGroups.some((group) => group.id === targetGroupId)
      ? strippedGroups.map((group) => (group.id === targetGroupId ? updatedTarget : group))
      : [...strippedGroups, updatedTarget]
    return merged.filter((group) => group.id === targetGroupId || group.tabOrder.length > 0)
  })()

  const nextTabBarOrder = (() => {
    const current = state.tabBarOrderByWorktree[worktreeId] ?? []
    const validTabBarIds = new Set([
      ...retainedUnifiedTabs.map((tab) => tab.id),
      ...mirroredUnifiedTabs.map((tab) => tab.id)
    ])
    const hostTabBarOrder =
      snapshot.tabGroups?.flatMap((group) =>
        group.tabOrder
          .map((tabId) => hostToLocalTabId.get(tabId))
          .filter((tabId): tabId is string => tabId !== undefined && validTabBarIds.has(tabId))
      ) ?? []
    return [
      ...current.filter((tabId) => validTabBarIds.has(tabId) && !mirroredUnifiedIds.has(tabId)),
      ...(hostTabBarOrder.length > 0 ? hostTabBarOrder : mirroredUnifiedTabs.map((tab) => tab.id))
    ]
  })()

  let nextPtyIdsByTabId = state.ptyIdsByTabId
  for (const removedId of removedTerminalIds) {
    if (nextPtyIdsByTabId[removedId]) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId ? { ...state.ptyIdsByTabId } : nextPtyIdsByTabId
      delete nextPtyIdsByTabId[removedId]
    }
  }
  for (const { tab, ptyIds } of mirroredTerminalTabs) {
    const current = nextPtyIdsByTabId[tab.id] ?? []
    if (!sameStringArray(current, ptyIds)) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId ? { ...state.ptyIdsByTabId } : nextPtyIdsByTabId
      nextPtyIdsByTabId[tab.id] = ptyIds
    }
  }

  let nextTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  for (const removedId of removedTerminalIds) {
    if (nextTerminalLayoutsByTabId[removedId]) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? { ...state.terminalLayoutsByTabId }
          : nextTerminalLayoutsByTabId
      delete nextTerminalLayoutsByTabId[removedId]
    }
  }
  for (const { tab, layout } of mirroredTerminalTabs) {
    if (!terminalLayoutEqual(nextTerminalLayoutsByTabId[tab.id], layout)) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? { ...state.terminalLayoutsByTabId }
          : nextTerminalLayoutsByTabId
      nextTerminalLayoutsByTabId[tab.id] = layout
    }
  }

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const removedId of removedTerminalIds) {
    if (nextUnreadTerminalTabs[removedId]) {
      nextUnreadTerminalTabs =
        nextUnreadTerminalTabs === state.unreadTerminalTabs
          ? { ...state.unreadTerminalTabs }
          : nextUnreadTerminalTabs
      delete nextUnreadTerminalTabs[removedId]
    }
  }

  let nextBrowserPagesByWorkspace = state.browserPagesByWorkspace
  let nextRemoteBrowserPageHandlesByPageId = state.remoteBrowserPageHandlesByPageId
  for (const removedWorkspaceId of removedBrowserWorkspaceIds) {
    const pages = nextBrowserPagesByWorkspace[removedWorkspaceId] ?? []
    if (nextBrowserPagesByWorkspace[removedWorkspaceId]) {
      nextBrowserPagesByWorkspace =
        nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
          ? { ...state.browserPagesByWorkspace }
          : nextBrowserPagesByWorkspace
      delete nextBrowserPagesByWorkspace[removedWorkspaceId]
    }
    for (const page of pages) {
      if (nextRemoteBrowserPageHandlesByPageId[page.id]) {
        nextRemoteBrowserPageHandlesByPageId =
          nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
            ? { ...state.remoteBrowserPageHandlesByPageId }
            : nextRemoteBrowserPageHandlesByPageId
        delete nextRemoteBrowserPageHandlesByPageId[page.id]
      }
    }
  }
  for (const { page, remotePageId } of mirroredBrowserTabs) {
    const current = nextBrowserPagesByWorkspace[page.workspaceId] ?? []
    if (!sameBrowserPages(current, [page])) {
      nextBrowserPagesByWorkspace =
        nextBrowserPagesByWorkspace === state.browserPagesByWorkspace
          ? { ...state.browserPagesByWorkspace }
          : nextBrowserPagesByWorkspace
      nextBrowserPagesByWorkspace[page.workspaceId] = [page]
    }
    const currentHandle = nextRemoteBrowserPageHandlesByPageId[page.id]
    if (
      currentHandle?.environmentId !== environmentId ||
      currentHandle.remotePageId !== remotePageId
    ) {
      nextRemoteBrowserPageHandlesByPageId =
        nextRemoteBrowserPageHandlesByPageId === state.remoteBrowserPageHandlesByPageId
          ? { ...state.remoteBrowserPageHandlesByPageId }
          : nextRemoteBrowserPageHandlesByPageId
      nextRemoteBrowserPageHandlesByPageId[page.id] = {
        environmentId,
        remotePageId
      }
    }
  }

  const nextTabsByWorktree = withWorktreeEntry(
    state.tabsByWorktree,
    worktreeId,
    nextTerminalTabs,
    sameTerminalTabs
  )
  const nextBrowserTabsByWorktree = withWorktreeEntry(
    state.browserTabsByWorktree,
    worktreeId,
    nextBrowserTabs,
    sameBrowserTabs
  )
  const nextUnifiedTabsByWorktree = withWorktreeEntry(
    state.unifiedTabsByWorktree,
    worktreeId,
    nextUnifiedTabs,
    sameUnifiedTabs
  )
  const nextGroupsByWorktree = withWorktreeEntry(
    state.groupsByWorktree,
    worktreeId,
    nextGroups,
    sameGroups
  )
  const nextActiveGroupId =
    nextGroups?.find((group) => group.id === snapshot.activeGroupId)?.id ??
    nextGroups?.find((group) => group.activeTabId === nextActiveUnifiedTabId)?.id ??
    nextGroups?.[0]?.id ??
    null
  const nextActiveGroupIdByWorktree =
    nextGroups && state.activeGroupIdByWorktree[worktreeId] !== nextActiveGroupId
      ? { ...state.activeGroupIdByWorktree, [worktreeId]: nextActiveGroupId ?? targetGroupId }
      : state.activeGroupIdByWorktree
  const nextLayoutByWorktree = (() => {
    if (!nextGroups) {
      return state.layoutByWorktree
    }
    const validGroupIds = new Set(nextGroups.map((group) => group.id))
    const hostLayout = pruneTabGroupLayout(snapshot.tabGroupLayout, validGroupIds)
    const defaultLeafLayout = { type: 'leaf' as const, groupId: nextActiveGroupId ?? targetGroupId }
    const hostLayoutGroupIds = collectLayoutGroupIds(hostLayout ?? undefined)
    const hostGroupIds = new Set(snapshot.tabGroups?.map((group) => group.id) ?? [])
    const extraGroupIds = new Set(
      nextGroups
        .map((group) => group.id)
        .filter((groupId) =>
          hostLayout
            ? !hostLayoutGroupIds.has(groupId)
            : snapshot.tabGroups && snapshot.tabGroups.length > 0
              ? !hostGroupIds.has(groupId)
              : false
        )
    )
    const localExtraLayout = pruneTabGroupLayout(state.layoutByWorktree[worktreeId], extraGroupIds)
    const hostBaseLayout =
      hostLayout ?? (snapshot.tabGroups && snapshot.tabGroups.length > 0 ? defaultLeafLayout : null)
    const fallbackLayout =
      appendTabGroupLayout(hostBaseLayout, localExtraLayout) ??
      (snapshot.tabGroups && snapshot.tabGroups.length > 0
        ? defaultLeafLayout
        : state.layoutByWorktree[worktreeId]
          ? null
          : defaultLeafLayout)
    if (!fallbackLayout) {
      return state.layoutByWorktree
    }
    if (tabGroupLayoutEqual(state.layoutByWorktree[worktreeId], fallbackLayout)) {
      return state.layoutByWorktree
    }
    return {
      ...state.layoutByWorktree,
      [worktreeId]: fallbackLayout
    }
  })()
  const nextTabBarOrderByWorktree = withWorktreeEntry(
    state.tabBarOrderByWorktree,
    worktreeId,
    nextTabBarOrder.length > 0 ? nextTabBarOrder : null,
    (a, b) => sameStringArray(a ?? [], b ?? [])
  )
  const nextActiveTabIdByWorktree =
    (state.activeTabIdByWorktree[worktreeId] ?? null) !== nextActiveTerminalId
      ? { ...state.activeTabIdByWorktree, [worktreeId]: nextActiveTerminalId }
      : state.activeTabIdByWorktree
  const nextActiveBrowserTabIdByWorktree =
    (state.activeBrowserTabIdByWorktree[worktreeId] ?? null) !== nextActiveBrowserWorkspaceId
      ? { ...state.activeBrowserTabIdByWorktree, [worktreeId]: nextActiveBrowserWorkspaceId }
      : state.activeBrowserTabIdByWorktree
  const nextActiveFileIdByWorktree =
    (state.activeFileIdByWorktree[worktreeId] ?? null) !== nextActiveEditorFileId
      ? { ...state.activeFileIdByWorktree, [worktreeId]: nextActiveEditorFileId }
      : state.activeFileIdByWorktree
  const isActiveWorktree = state.activeWorktreeId === worktreeId
  const snapshotVisibleTabType =
    snapshot.activeTabType === 'browser' && nextActiveBrowserWorkspaceId
      ? ('browser' as const)
      : snapshot.activeTabType === 'terminal' && nextActiveTerminalId
        ? ('terminal' as const)
        : (snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file') &&
            nextActiveEditorFileId
          ? ('editor' as const)
          : null
  const currentVisibleTabType =
    state.activeTabTypeByWorktree[worktreeId] ?? (isActiveWorktree ? state.activeTabType : null)
  const currentVisibleTabTypeStillValid =
    currentVisibleTabType === 'browser' && nextActiveBrowserWorkspaceId
      ? ('browser' as const)
      : currentVisibleTabType === 'editor' && nextActiveEditorFileId
        ? ('editor' as const)
        : currentVisibleTabType === 'terminal' && nextActiveTerminalId
          ? ('terminal' as const)
          : null
  const activeUnifiedTab =
    nextActiveUnifiedTabId && nextUnifiedTabs
      ? (nextUnifiedTabs.find((tab) => tab.id === nextActiveUnifiedTabId) ?? null)
      : null
  const fallbackVisibleTabType =
    activeUnifiedTab !== null
      ? toVisibleTabType(activeUnifiedTab)
      : nextActiveTerminalId
        ? ('terminal' as const)
        : nextActiveBrowserWorkspaceId
          ? ('browser' as const)
          : nextActiveEditorFileId
            ? ('editor' as const)
            : ('terminal' as const)
  // Why: an empty/closed host snapshot has no active host tab, but the web
  // client must not keep pointing global shortcuts at a removed browser/editor.
  const nextVisibleTabType =
    snapshotVisibleTabType ?? currentVisibleTabTypeStillValid ?? fallbackVisibleTabType
  const currentActiveTerminalStillValid =
    state.activeTabId && (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : null
  const currentActiveEditorStillValid =
    state.activeFileId &&
    nextOpenFiles.some((file) => file.worktreeId === worktreeId && file.id === state.activeFileId)
      ? state.activeFileId
      : null
  const nextActiveTabId = isActiveWorktree
    ? snapshot.activeTabType === 'terminal'
      ? nextActiveTerminalId
      : (currentActiveTerminalStillValid ?? nextActiveTerminalId)
    : state.activeTabId
  const nextActiveBrowserTabId = isActiveWorktree
    ? nextActiveBrowserWorkspaceId
    : state.activeBrowserTabId
  const nextActiveFileId = isActiveWorktree
    ? snapshot.activeTabType === 'markdown' || snapshot.activeTabType === 'file'
      ? nextActiveEditorFileId
      : (currentActiveEditorStillValid ?? nextActiveEditorFileId)
    : state.activeFileId
  const nextActiveTabType = isActiveWorktree ? nextVisibleTabType : state.activeTabType
  const nextActiveTabTypeByWorktree =
    state.activeTabTypeByWorktree[worktreeId] !== nextVisibleTabType
      ? { ...state.activeTabTypeByWorktree, [worktreeId]: nextVisibleTabType }
      : state.activeTabTypeByWorktree
  const agentStatusPatch = buildMirroredAgentStatusPatch(
    state,
    currentTerminalTabs,
    terminalSurfaceTabs,
    now
  )

  const patch: Partial<WebSessionTabsSyncState> = {
    ...agentStatusPatch,
    ...(nextOpenFiles !== state.openFiles ? { openFiles: nextOpenFiles } : {}),
    ...(nextTabsByWorktree !== state.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
    ...(nextBrowserTabsByWorktree !== state.browserTabsByWorktree
      ? { browserTabsByWorktree: nextBrowserTabsByWorktree }
      : {}),
    ...(nextUnifiedTabsByWorktree !== state.unifiedTabsByWorktree
      ? { unifiedTabsByWorktree: nextUnifiedTabsByWorktree }
      : {}),
    ...(nextGroupsByWorktree !== state.groupsByWorktree
      ? { groupsByWorktree: nextGroupsByWorktree }
      : {}),
    ...(nextActiveGroupIdByWorktree !== state.activeGroupIdByWorktree
      ? { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }
      : {}),
    ...(nextLayoutByWorktree !== state.layoutByWorktree
      ? { layoutByWorktree: nextLayoutByWorktree }
      : {}),
    ...(nextTabBarOrderByWorktree !== state.tabBarOrderByWorktree
      ? { tabBarOrderByWorktree: nextTabBarOrderByWorktree }
      : {}),
    ...(nextPtyIdsByTabId !== state.ptyIdsByTabId ? { ptyIdsByTabId: nextPtyIdsByTabId } : {}),
    ...(nextTerminalLayoutsByTabId !== state.terminalLayoutsByTabId
      ? { terminalLayoutsByTabId: nextTerminalLayoutsByTabId }
      : {}),
    ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
      ? { unreadTerminalTabs: nextUnreadTerminalTabs }
      : {}),
    ...(nextBrowserPagesByWorkspace !== state.browserPagesByWorkspace
      ? { browserPagesByWorkspace: nextBrowserPagesByWorkspace }
      : {}),
    ...(nextRemoteBrowserPageHandlesByPageId !== state.remoteBrowserPageHandlesByPageId
      ? { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
      : {}),
    ...(nextActiveTabIdByWorktree !== state.activeTabIdByWorktree
      ? { activeTabIdByWorktree: nextActiveTabIdByWorktree }
      : {}),
    ...(nextActiveBrowserTabIdByWorktree !== state.activeBrowserTabIdByWorktree
      ? { activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree }
      : {}),
    ...(nextActiveFileIdByWorktree !== state.activeFileIdByWorktree
      ? { activeFileIdByWorktree: nextActiveFileIdByWorktree }
      : {}),
    ...(nextActiveTabId !== state.activeTabId ? { activeTabId: nextActiveTabId } : {}),
    ...(nextActiveBrowserTabId !== state.activeBrowserTabId
      ? { activeBrowserTabId: nextActiveBrowserTabId }
      : {}),
    ...(nextActiveFileId !== state.activeFileId ? { activeFileId: nextActiveFileId } : {}),
    ...(nextActiveTabType !== state.activeTabType ? { activeTabType: nextActiveTabType } : {}),
    ...(nextActiveTabTypeByWorktree !== state.activeTabTypeByWorktree
      ? { activeTabTypeByWorktree: nextActiveTabTypeByWorktree }
      : {})
  }

  return Object.keys(patch).length === 0 ? state : patch
}

export function applyWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  let nextState = state
  let mergedPatch: Partial<WebSessionTabsSyncState> = {}
  for (const snapshot of snapshots) {
    const patch = applyWebSessionTabsSnapshot(nextState, snapshot, environmentId, now)
    if (patch === nextState) {
      continue
    }
    mergedPatch = { ...mergedPatch, ...patch }
    nextState = { ...nextState, ...patch }
  }
  return Object.keys(mergedPatch).length === 0 ? state : mergedPatch
}

export function applyFreshWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  if (!shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)) {
    return state
  }
  return applyWebSessionTabsSnapshot(state, snapshot, environmentId, now)
}

export function applyFreshWebSessionTabsSnapshots(
  state: WebSessionTabsSyncState,
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const freshSnapshots = snapshots.filter((snapshot) =>
    shouldApplyWebSessionTabsSnapshot(snapshot, environmentId)
  )
  return freshSnapshots.length === 0
    ? state
    : applyWebSessionTabsSnapshots(state, freshSnapshots, environmentId, now)
}

export function useWebSessionTabsSync(): void {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeRuntimeEnvironmentId = useAppStore(
    (state) => state.settings?.activeRuntimeEnvironmentId ?? null
  )
  const workspaceSessionReady = useAppStore((state) => state.workspaceSessionReady)

  useEffect(() => {
    const environmentId = activeRuntimeEnvironmentId?.trim()
    // Why: startup hydration writes browser-local session state; applying the
    // host snapshot before that point gets clobbered and leaves the sidebar stale.
    if (!isWebClient() || !environmentId || !workspaceSessionReady) {
      return
    }

    let disposed = false
    let unsubscribe: (() => void) | null = null
    // Why: the streaming RPC emits an initial snapshots event, but startup can
    // render a paired web session before that event is applied. A one-shot
    // fetch makes initial parity deterministic; the stream remains the live
    // update path afterward.
    void window.api.runtimeEnvironments
      .call({
        selector: environmentId,
        method: 'session.tabs.listAll',
        params: {},
        timeoutMs: 15_000
      })
      .then((response: RuntimeRpcResponse<unknown>) => {
        if (disposed) {
          return
        }
        if (response.ok === false) {
          console.warn('[web-session-tabs-sync] initial listAll failed:', response.error.message)
          return
        }
        const result = response.result
        if (!isSessionTabsListAllResult(result)) {
          console.warn('[web-session-tabs-sync] initial listAll returned an invalid payload')
          return
        }
        useAppStore.setState((state) =>
          applyFreshWebSessionTabsSnapshots(state, result.snapshots, environmentId)
        )
      })
      .catch((error) => {
        if (!disposed) {
          console.warn(
            '[web-session-tabs-sync] failed to load initial session tabs:',
            error instanceof Error ? error.message : String(error)
          )
        }
      })

    void window.api.runtimeEnvironments
      .subscribe(
        {
          selector: environmentId,
          method: 'session.tabs.subscribeAll',
          params: {},
          timeoutMs: 15_000
        },
        {
          onResponse: (response: RuntimeRpcResponse<unknown>) => {
            if (disposed) {
              return
            }
            if (response.ok === false) {
              console.warn(
                '[web-session-tabs-sync] global subscription failed:',
                response.error.message
              )
              return
            }
            const event = response.result as SessionTabsStreamEvent
            if (event.type === 'snapshots') {
              useAppStore.setState((state) =>
                applyFreshWebSessionTabsSnapshots(state, event.snapshots, environmentId)
              )
              return
            }
            if (event.type !== 'snapshot' && event.type !== 'updated') {
              return
            }
            useAppStore.setState((state) =>
              applyFreshWebSessionTabsSnapshot(state, event, environmentId)
            )
          },
          onError: (error) => {
            console.warn('[web-session-tabs-sync] global subscription error:', error.message)
          }
        }
      )
      .then((handle) => {
        if (disposed) {
          handle.unsubscribe()
          return
        }
        unsubscribe = handle.unsubscribe
      })
      .catch((error) => {
        if (!disposed) {
          console.warn(
            '[web-session-tabs-sync] failed to subscribe globally:',
            error instanceof Error ? error.message : String(error)
          )
        }
      })

    return () => {
      disposed = true
      unsubscribe?.()
      // Why: environment ids can churn as paired runtimes reconnect or switch;
      // stale freshness/mapping entries should not live for the renderer lifetime.
      clearWebSessionTabsTrackingForEnvironment(environmentId)
    }
  }, [activeRuntimeEnvironmentId, workspaceSessionReady])

  useEffect(() => {
    const environmentId = activeRuntimeEnvironmentId?.trim()
    if (!isWebClient() || !activeWorktreeId || !environmentId || !workspaceSessionReady) {
      return
    }

    let disposed = false
    let requestedInitialTerminal = false
    let requestedRespawnAfterWake = false
    let unsubscribe: (() => void) | null = null
    void window.api.runtimeEnvironments
      .subscribe(
        {
          selector: environmentId,
          method: 'session.tabs.subscribe',
          params: { worktree: toRuntimeWorktreeSelector(activeWorktreeId) },
          timeoutMs: 15_000
        },
        {
          onResponse: (response: RuntimeRpcResponse<unknown>) => {
            if (disposed) {
              return
            }
            if (response.ok === false) {
              console.warn('[web-session-tabs-sync] subscription failed:', response.error.message)
              return
            }
            const event = response.result as SessionTabsStreamEvent
            if (event.type !== 'snapshot' && event.type !== 'updated') {
              return
            }
            const fresh = shouldApplyWebSessionTabsSnapshot(event, environmentId)
            const syncState = useAppStore.getState()
            const localWorktreeTabs = syncState.tabsByWorktree[activeWorktreeId] ?? []
            const localTerminalCount = localWorktreeTabs.length
            const hasLiveLocalPty = localWorktreeTabs.some(
              (tab) => (syncState.ptyIdsByTabId[tab.id] ?? []).length > 0
            )
            const shouldBootstrapInitialTerminal = shouldBootstrapInitialWebRuntimeTerminal({
              event,
              activeWorktreeId,
              requestedInitialTerminal,
              snapshotIsFresh: fresh,
              localTerminalCount
            })
            const shouldRespawnAfterWake = shouldRespawnWebRuntimeTerminalAfterWake({
              event,
              activeWorktreeId,
              requestedRespawnAfterWake,
              snapshotIsFresh: fresh,
              localTerminalCount,
              hasLiveLocalPty,
              skipWakeRespawn: shouldSkipWebRuntimeWakeTerminalRespawn(activeWorktreeId)
            })
            if (fresh) {
              useAppStore.setState((state) =>
                applyWebSessionTabsSnapshot(state, event, environmentId)
              )
            }
            if (!disposed && shouldBootstrapInitialTerminal) {
              requestedInitialTerminal = true
              void createWebRuntimeSessionTerminal({
                worktreeId: activeWorktreeId,
                environmentId,
                activate: true
              })
            } else if (
              !disposed &&
              shouldRespawnAfterWake &&
              beginWebRuntimeWakeTerminalRespawn(activeWorktreeId)
            ) {
              requestedRespawnAfterWake = true
              // Why: wake recovery must recreate the terminal without changing
              // selected worktree to avoid re-triggering activation churn.
              void createWebRuntimeSessionTerminal({
                worktreeId: activeWorktreeId,
                environmentId,
                activate: true,
                selectWorktree: false
              }).finally(() => {
                endWebRuntimeWakeTerminalRespawn(activeWorktreeId)
              })
            }
          },
          onError: (error) => {
            console.warn('[web-session-tabs-sync] subscription error:', error.message)
          }
        }
      )
      .then((handle) => {
        if (disposed) {
          handle.unsubscribe()
          return
        }
        unsubscribe = handle.unsubscribe
      })
      .catch((error) => {
        if (!disposed) {
          console.warn(
            '[web-session-tabs-sync] failed to subscribe:',
            error instanceof Error ? error.message : String(error)
          )
        }
      })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [activeRuntimeEnvironmentId, activeWorktreeId, workspaceSessionReady])
}
