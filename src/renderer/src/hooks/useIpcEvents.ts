/* oxlint-disable max-lines -- Why: this App-level IPC bridge intentionally keeps the renderer's main-process event contract in one place so shortcut, runtime, updater, and agent-status wiring do not drift across files. */
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import { getWorktreeMapFromState, getRepoMapFromState } from '@/store/selectors'
import { applyUIZoom } from '@/lib/ui-zoom'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'
import { OPEN_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/useWorkspaceBoardPanel'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  SPLIT_TERMINAL_PANE_EVENT,
  CLOSE_TERMINAL_PANE_EVENT
} from '@/constants/terminal'
import type { SplitTerminalPaneDetail, CloseTerminalPaneDetail } from '@/constants/terminal'
import { getVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { activateTabNumberShortcut } from '@/lib/tab-number-shortcuts'
import { nextEditorFontZoomLevel, computeEditorFontSize } from '@/lib/editor-font-zoom'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  UpdateStatus,
  WorkspaceSessionState
} from '../../../shared/types'
import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../../shared/remote-workspace-types'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type {
  RuntimeBrowserDriverState,
  RuntimeTerminalDriverState
} from '../../../shared/runtime-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import { zoomLevelToPercent, ZOOM_MIN, ZOOM_MAX } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { canShowRightSidebarForView } from '@/lib/right-sidebar-visibility'
import { resolveZoomTarget } from './resolve-zoom-target'
import {
  handleSwitchRecentTab,
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'
import { ensureSimulatorTab } from '@/lib/ensure-simulator-tab'
import { openMobileEmulatorTab } from '@/lib/open-mobile-emulator-tab'
import {
  isManualSimulatorLaunchPending,
  rememberPrelaunchedSimulatorSession
} from '@/lib/simulator-launch-coordination'
import {
  normalizeAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../../shared/agent-status-types'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../shared/agent-status-identity'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { focusRuntimeTerminalSurface } from '@/runtime/sync-runtime-graph'
import { setFitOverride, hydrateOverrides } from '@/lib/pane-manager/mobile-fit-overrides'
import { setDriverForPty, hydrateDrivers } from '@/lib/pane-manager/mobile-driver-state'
import {
  hydrateBrowserDrivers,
  setDriverForBrowserPage
} from '@/lib/pane-manager/browser-mobile-driver-state'
import { destroyPersistentWebview } from '@/components/browser-pane/webview-registry'
import { dispatchBrowserPageZoomEvent } from '@/components/browser-pane/browser-page-zoom'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '@/components/browser-pane/browser-automation-visibility'
import { attachMobileMarkdownBridge } from '@/runtime/mobile-markdown-bridge'
import { subscribeRuntimeClientEvents } from '@/runtime/runtime-client-events'
import { detectLanguage } from '@/lib/language-detect'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { track } from '@/lib/telemetry'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { AppState } from '../store/types'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '../store/pinned-tab-close-guard'
import {
  closeWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import {
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  createFloatingWorkspaceTerminalTab,
  isEmptyFloatingWorkspacePanelVisible,
  isFloatingWorkspacePanelFocused,
  switchFloatingWorkspaceTab
} from '@/lib/floating-workspace-terminal-actions'
import {
  observeAgentHookCompletionForNotification,
  resetAgentHookCompletionNotificationCoordinators,
  syncAgentHookCompletionNotificationSettings
} from './agent-hook-completion-notifications'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import { titleHasAgentName } from '../../../shared/agent-detection'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'

function getShortcutPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  return 'linux'
}

const BROWSER_AUTOMATION_BOOTSTRAP_LEASE_MS = 10_000
const browserAutomationBootstrapLeaseByPageId = new Map<string, { token: string; timer: number }>()

function isPinnedSessionTab(store: AppState, worktreeId: string, visibleId: string): boolean {
  return (store.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
    (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
  )
}

function releaseBrowserAutomationBootstrapLease(browserPageId: string): void {
  const existing = browserAutomationBootstrapLeaseByPageId.get(browserPageId)
  if (!existing) {
    return
  }
  window.clearTimeout(existing.timer)
  releaseBrowserAutomationVisibility(existing.token)
  browserAutomationBootstrapLeaseByPageId.delete(browserPageId)
}

function findBrowserPageWorktreeId(store: AppState, browserPageId: string): string | null {
  for (const [worktreeId, browserTabs] of Object.entries(store.browserTabsByWorktree)) {
    for (const workspace of browserTabs) {
      if (
        workspace.id === browserPageId ||
        workspace.activePageId === browserPageId ||
        workspace.pageIds?.includes(browserPageId)
      ) {
        return worktreeId
      }
    }
  }

  for (const pages of Object.values(store.browserPagesByWorkspace)) {
    const page = pages.find((candidate) => candidate.id === browserPageId)
    if (page) {
      return page.worktreeId
    }
  }

  return null
}

function acquireBrowserAutomationBootstrapLease(
  worktreeId: string | null | undefined,
  browserPageId?: string | null
): void {
  const store = useAppStore.getState()
  const targetWorktreeId =
    worktreeId ??
    (browserPageId ? findBrowserPageWorktreeId(store, browserPageId) : null) ??
    store.activeWorktreeId
  if (!targetWorktreeId) {
    return
  }
  window.dispatchEvent(
    new CustomEvent(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, {
      detail: { worktreeId: targetWorktreeId }
    })
  )
  let targetBrowserPageId = browserPageId ?? null
  if (!targetBrowserPageId) {
    const browserTabs = store.browserTabsByWorktree[targetWorktreeId] ?? []
    const activeWorkspaceId = store.activeBrowserTabIdByWorktree[targetWorktreeId] ?? null
    const workspace =
      browserTabs.find((tab) => tab.id === activeWorkspaceId) ?? browserTabs[0] ?? null
    targetBrowserPageId =
      workspace?.activePageId ?? workspace?.pageIds?.[0] ?? workspace?.id ?? null
  }
  if (!targetBrowserPageId) {
    return
  }

  releaseBrowserAutomationBootstrapLease(targetBrowserPageId)
  const token = acquireBrowserAutomationVisibility(targetBrowserPageId)
  const timer = window.setTimeout(() => {
    releaseBrowserAutomationBootstrapLease(targetBrowserPageId)
  }, BROWSER_AUTOMATION_BOOTSTRAP_LEASE_MS)
  browserAutomationBootstrapLeaseByPageId.set(targetBrowserPageId, { token, timer })
}

export { resolveZoomTarget } from './resolve-zoom-target'

const ZOOM_STEP = 0.5
const PENDING_AGENT_STATUS_RETRY_MS = 100
const PENDING_AGENT_STATUS_TTL_MS = 15_000
const MAX_PENDING_AGENT_STATUS_EVENTS = 100
// Why: mobile driver hydration is async; cap transient replay so a stuck IPC
// snapshot cannot retain an unbounded startup buffer.
const MAX_PENDING_MOBILE_STATE_EVENTS = 300
// Why: a folder rename emits a burst of `worktrees:changed` events while the
// worktree list lags the on-disk move, so the deletion diff can transiently see
// the old OR new id as "removed" and tear down the live worktree's PTYs. Protect
// both ids of a recent rename from that diff for a short grace window — genuine
// out-of-band deletions still purge once it lapses. Keyed worktreeId -> expiry ms.
const WORKTREE_RENAME_PURGE_GRACE_MS = 20_000
const recentlyRenamedWorktreeIdExpiry = new Map<string, number>()
let remoteWorkspaceSnapshotApplyDepth = 0
let remoteWorkspaceSnapshotWriteSuppressUntil = 0
const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1000

function getAuthoritativeDetectedWorktreeIds(state: AppState, repoId: string): Set<string> | null {
  const detected = state.detectedWorktreesByRepo[repoId]
  if (detected?.authoritative !== true) {
    return null
  }
  return new Set(detected.worktrees.map((worktree) => worktree.id))
}

function getVisibleWorktreeIdsForRepo(state: AppState, repoId: string): Set<string> {
  return new Set((state.worktreesByRepo[repoId] ?? []).map((worktree) => worktree.id))
}

function resolveActiveBrowserPageId(state: AppState): string | null {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const activeWorkspaceId =
    state.activeBrowserTabIdByWorktree[worktreeId] ?? state.activeBrowserTabId ?? null
  const browserWorkspaces = state.browserTabsByWorktree[worktreeId] ?? []
  const workspace =
    browserWorkspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? null
  if (!workspace) {
    return null
  }
  const pages = state.browserPagesByWorkspace[workspace.id] ?? []
  return workspace.activePageId ?? workspace.pageIds?.[0] ?? pages[0]?.id ?? null
}

type TerminalSplitDirection = 'horizontal' | 'vertical'

function insertLeafAfterSource(
  node: TerminalPaneLayoutNode,
  sourceLeafId: string,
  newLeafId: string,
  direction: TerminalSplitDirection
): { node: TerminalPaneLayoutNode; inserted: boolean } {
  if (node.type === 'leaf') {
    if (node.leafId !== sourceLeafId) {
      return { node, inserted: false }
    }
    return {
      node: {
        type: 'split',
        direction,
        first: node,
        second: { type: 'leaf', leafId: newLeafId },
        ratio: 0.5
      },
      inserted: true
    }
  }

  const first = insertLeafAfterSource(node.first, sourceLeafId, newLeafId, direction)
  if (first.inserted) {
    return { node: { ...node, first: first.node }, inserted: true }
  }
  const second = insertLeafAfterSource(node.second, sourceLeafId, newLeafId, direction)
  if (second.inserted) {
    return { node: { ...node, second: second.node }, inserted: true }
  }
  return { node, inserted: false }
}

function addSplitLeafToLayout(
  layout: TerminalLayoutSnapshot | null | undefined,
  sourceLeafId: string,
  newLeafId: string,
  ptyId: string,
  direction: TerminalSplitDirection,
  title?: string | null,
  activateNewLeaf = true
): TerminalLayoutSnapshot {
  const root = layout?.root ?? { type: 'leaf', leafId: sourceLeafId }
  const existingLeafIds = collectLeafIdsInOrder(root)
  const nextActiveLeafId =
    activateNewLeaf || !layout?.activeLeafId || !existingLeafIds.includes(layout.activeLeafId)
      ? newLeafId
      : layout.activeLeafId
  const nextRoot = existingLeafIds.includes(newLeafId)
    ? root
    : (() => {
        const inserted = insertLeafAfterSource(root, sourceLeafId, newLeafId, direction)
        if (inserted.inserted) {
          return inserted.node
        }
        return {
          type: 'split' as const,
          direction,
          first: root,
          second: { type: 'leaf' as const, leafId: newLeafId },
          ratio: 0.5
        }
      })()
  return {
    ...(layout ?? { root: null, activeLeafId: null, expandedLeafId: null }),
    root: nextRoot,
    activeLeafId: nextActiveLeafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      ...layout?.ptyIdsByLeafId,
      [newLeafId]: ptyId
    },
    ...(title
      ? {
          titlesByLeafId: {
            ...layout?.titlesByLeafId,
            [newLeafId]: title
          }
        }
      : {})
  }
}

function activateExistingLeafInLayout(
  layout: TerminalLayoutSnapshot | null | undefined,
  leafId: string,
  ptyId: string,
  title?: string | null
): TerminalLayoutSnapshot | null {
  if (!layout?.root || !collectLeafIdsInOrder(layout.root).includes(leafId)) {
    return null
  }
  return {
    ...layout,
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {
      ...layout.ptyIdsByLeafId,
      [leafId]: ptyId
    },
    ...(title
      ? {
          titlesByLeafId: {
            ...layout.titlesByLeafId,
            [leafId]: title
          }
        }
      : {})
  }
}

export function isRemoteWorkspaceSnapshotApplyInProgress(): boolean {
  return (
    remoteWorkspaceSnapshotApplyDepth > 0 || Date.now() < remoteWorkspaceSnapshotWriteSuppressUntil
  )
}

async function waitForWorkspaceSessionReady(): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (useAppStore.getState().workspaceSessionReady) {
      return true
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  return useAppStore.getState().workspaceSessionReady
}

async function prepareRemoteWorkspaceTarget(targetId: string): Promise<boolean> {
  if (!(await waitForWorkspaceSessionReady())) {
    return false
  }
  const store = useAppStore.getState()
  let repos = store.repos.filter((repo) => repo.connectionId === targetId)
  if (repos.length === 0) {
    await store.fetchRepos()
    repos = useAppStore.getState().repos.filter((repo) => repo.connectionId === targetId)
  }
  await Promise.all(repos.map((repo) => useAppStore.getState().fetchWorktrees(repo.id)))
  await useAppStore.getState().fetchWorktreeLineage()
  return true
}

function targetRepoIds(targetId: string): Set<string> {
  return new Set(
    useAppStore
      .getState()
      .repos.filter((repo) => repo.connectionId === targetId)
      .map((repo) => repo.id)
  )
}

function targetWorktreeIds(targetId: string): Set<string> {
  const repoIds = targetRepoIds(targetId)
  return new Set(
    Object.values(useAppStore.getState().worktreesByRepo)
      .flat()
      .filter((worktree) => repoIds.has(worktree.repoId))
      .map((worktree) => worktree.id)
  )
}

function mergeRemoteWorkspaceSession(
  current: WorkspaceSessionState,
  remote: WorkspaceSessionState,
  targetId: string
): WorkspaceSessionState {
  const replaceWorktreeIds = targetWorktreeIds(targetId)
  const remoteTabIds = new Set(
    Object.values(remote.tabsByWorktree)
      .flat()
      .map((tab) => tab.id)
  )
  const replacedTabIds = new Set([
    ...remoteTabIds,
    ...Object.entries(current.tabsByWorktree)
      .filter(([worktreeId]) => replaceWorktreeIds.has(worktreeId))
      .flatMap(([, tabs]) => tabs.map((tab) => tab.id))
  ])
  const omitTargetWorktrees = <T>(record: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record ?? {}).filter(([worktreeId]) => !replaceWorktreeIds.has(worktreeId))
    )

  return {
    ...current,
    activeRepoId:
      remote.activeRepoId ??
      (current.activeWorktreeId && replaceWorktreeIds.has(current.activeWorktreeId)
        ? null
        : current.activeRepoId),
    activeWorktreeId:
      remote.activeWorktreeId ??
      (current.activeWorktreeId && replaceWorktreeIds.has(current.activeWorktreeId)
        ? null
        : current.activeWorktreeId),
    activeTabId:
      remote.activeTabId ??
      (current.activeTabId && replacedTabIds.has(current.activeTabId) ? null : current.activeTabId),
    tabsByWorktree: {
      ...omitTargetWorktrees(current.tabsByWorktree),
      ...remote.tabsByWorktree
    },
    terminalLayoutsByTabId: {
      ...Object.fromEntries(
        Object.entries(current.terminalLayoutsByTabId).filter(
          ([tabId]) => !replacedTabIds.has(tabId)
        )
      ),
      ...remote.terminalLayoutsByTabId
    },
    activeWorktreeIdsOnShutdown: [
      ...(current.activeWorktreeIdsOnShutdown ?? []).filter((id) => !replaceWorktreeIds.has(id)),
      ...(remote.activeWorktreeIdsOnShutdown ?? [])
    ],
    activeTabIdByWorktree: {
      ...omitTargetWorktrees(current.activeTabIdByWorktree),
      ...remote.activeTabIdByWorktree
    },
    remoteSessionIdsByTabId: {
      ...Object.fromEntries(
        Object.entries(current.remoteSessionIdsByTabId ?? {}).filter(
          ([tabId]) => !replacedTabIds.has(tabId)
        )
      ),
      ...remote.remoteSessionIdsByTabId
    },
    lastVisitedAtByWorktreeId: {
      ...omitTargetWorktrees(current.lastVisitedAtByWorktreeId),
      ...remote.lastVisitedAtByWorktreeId
    }
  }
}

async function applyRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): Promise<void> {
  if (!(await prepareRemoteWorkspaceTarget(targetId))) {
    throw new Error('Workspace sync waited for local session hydration and timed out')
  }
  const worktreeIds = targetWorktreeIds(targetId)
  const localByPath = new Map(
    Array.from(worktreeIds).map((worktreeId) => {
      const separator = worktreeId.indexOf('::')
      return [separator === -1 ? worktreeId : worktreeId.slice(separator + 2), worktreeId] as const
    })
  )
  const remoteSession = importRemoteWorkspaceSession(snapshot.session, {
    resolveWorktreeId: (worktreePath) => localByPath.get(worktreePath) ?? null
  })
  const current = buildWorkspaceSessionPayload(useAppStore.getState())
  const merged = mergeRemoteWorkspaceSession(current, remoteSession, targetId)
  const store = useAppStore.getState()
  remoteWorkspaceSnapshotApplyDepth += 1
  try {
    store.hydrateWorkspaceSession(merged)
    store.hydrateTabsSession(merged)
    store.hydrateEditorSession(merged)
    store.hydrateBrowserSession(merged)
    store.markRemoteWorkspaceHydrated(targetId)
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'pull',
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.4f78ba5885', 'Workspace synced')
    })
    await useAppStore.getState().reconnectPersistedTerminals()
  } finally {
    // Why: remote terminal reattach can update pty ids and titles just after
    // hydration. Those local side effects came from the remote snapshot and
    // must not echo back as a fresh workspace revision.
    remoteWorkspaceSnapshotWriteSuppressUntil =
      Date.now() + REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS
    remoteWorkspaceSnapshotApplyDepth -= 1
  }
}

async function syncRemoteWorkspaceAfterConnect(targetId: string): Promise<void> {
  const store = useAppStore.getState()
  if (!(await prepareRemoteWorkspaceTarget(targetId))) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'error',
      direction: 'pull',
      message: translate(
        'auto.hooks.useIpcEvents.88214a785b',
        'Workspace sync waited for local session hydration and timed out'
      )
    })
    return
  }
  store.setRemoteWorkspaceSyncStatus(targetId, { phase: 'pulling', direction: 'pull' })
  const worktreeIds = targetWorktreeIds(targetId)
  const hasLocalTabs = Array.from(worktreeIds).some(
    (worktreeId) => (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).length > 0
  )
  const snapshot = await window.api.remoteWorkspace.get({ targetId })
  if (!snapshot) {
    useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'offline',
      direction: 'pull',
      message: translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable')
    })
    return
  }
  if (snapshot.revision > 0) {
    await applyRemoteWorkspaceSnapshot(targetId, snapshot)
    return
  }

  useAppStore.getState().markRemoteWorkspaceHydrated(targetId)
  if (hasLocalTabs) {
    // Why: first connect must read the relay before publishing local tabs.
    // Otherwise a reconnecting device can overwrite a newer cross-device
    // workspace snapshot with stale local renderer state.
    const session = buildWorkspaceSessionPayload(useAppStore.getState())
    const results = await window.api.remoteWorkspace.setForConnectedTargets({
      session,
      hydratedTargetIds: [targetId]
    })
    const result = results.find((entry) => entry.targetId === targetId)?.result
    applyRemoteWorkspacePatchStatus(targetId, result)
    if (result?.ok) {
      useAppStore.getState().markRemoteWorkspaceHydrated(targetId)
    }
    return
  }
  useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
    phase: 'idle',
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
    message: translate('auto.hooks.useIpcEvents.2ec42e1c52', 'No remote workspace yet')
  })
}

function applyRemoteWorkspacePatchStatus(
  targetId: string,
  result: RemoteWorkspacePatchResult | undefined
): void {
  if (!result) {
    useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'offline',
      direction: 'push',
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable')
    })
    return
  }
  if (result.ok) {
    useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.f8aaf2bde3', 'Workspace uploaded')
    })
    return
  }
  useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
    phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
    direction: 'push',
    revision: result.snapshot?.revision,
    updatedAt: result.snapshot?.updatedAt,
    lastSyncedAt: Date.now(),
    message:
      result.message ??
      (result.reason === 'stale-revision'
        ? 'Workspace changed on another device'
        : 'Remote workspace sync unavailable')
  })
}

type BrowserSessionTabTarget =
  | { kind: 'unified-browser'; unifiedTabId: string; workspaceId: string; groupId: string }
  | { kind: 'fallback-browser'; workspaceId: string }

type NewWorkspaceShortcutModalData = {
  telemetrySource: 'shortcut'
  prefilledName?: string
  linkedWorkItem?: ReturnType<typeof buildLinearIssueLinkedWorkItem>
}

export function buildNewWorkspaceShortcutModalData(
  state: Pick<AppState, 'activeView' | 'taskPageData'>
): NewWorkspaceShortcutModalData {
  const linearIssue =
    state.activeView === 'tasks' ? (state.taskPageData.openLinearIssue ?? null) : null
  if (!linearIssue) {
    return { telemetrySource: 'shortcut' }
  }

  return {
    telemetrySource: 'shortcut',
    prefilledName: getLinearIssueWorkspaceName(linearIssue),
    // Why: Cmd+N from a Linear issue should behave like the issue's Start
    // workspace action; otherwise the agent launches without source context.
    linkedWorkItem: buildLinearIssueLinkedWorkItem(linearIssue)
  }
}

export function openNewWorkspaceFromShortcut(
  state: Pick<AppState, 'activeModal' | 'activeView' | 'taskPageData' | 'openModal'>
): void {
  if (state.activeModal === 'new-workspace-composer') {
    return
  }
  state.openModal('new-workspace-composer', buildNewWorkspaceShortcutModalData(state))
}

export function resolveBrowserSessionTabTarget(
  state: Pick<AppState, 'browserTabsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  tabId: string
): BrowserSessionTabTarget | null {
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find((item) => item.id === tabId)
  if (tab?.contentType === 'browser') {
    return {
      kind: 'unified-browser',
      unifiedTabId: tab.id,
      workspaceId: tab.entityId,
      groupId: tab.groupId
    }
  }
  const fallbackBrowser = (state.browserTabsByWorktree[worktreeId] ?? []).find(
    (workspace) => workspace.id === tabId
  )
  return fallbackBrowser ? { kind: 'fallback-browser', workspaceId: fallbackBrowser.id } : null
}

function isRuntimeEnvironmentActive(): boolean {
  return Boolean(useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim())
}

function getActiveRuntimeEnvironmentId(): string | null {
  return useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() || null
}

function getRuntimeClientEventEnvironmentIds(): string[] {
  const state = useAppStore.getState()
  const ids = new Set<string>()
  const activeEnvironmentId = getActiveRuntimeEnvironmentId()
  if (activeEnvironmentId) {
    ids.add(activeEnvironmentId)
  }
  for (const environment of state.runtimeEnvironments ?? []) {
    const status = state.runtimeStatusByEnvironmentId?.get(environment.id)
    if (status?.status) {
      ids.add(environment.id)
    }
  }
  return [...ids]
}

function getWorktreeRuntimeEnvironmentId(worktreeId: string | null | undefined): string | null {
  return getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
}

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []
    type PendingAgentStatusEvent = {
      data: AgentStatusIpcPayload
      firstSeenAt: number
    }
    type AgentStatusApplyResult = 'applied' | 'pending' | 'dropped'
    const pendingAgentStatusEvents: PendingAgentStatusEvent[] = []
    let pendingAgentStatusRetryTimer: ReturnType<typeof setTimeout> | null = null
    const runtimeClientEventsSubscriptions = new Map<string, () => void>()
    const runtimeClientEventsPending = new Set<string>()
    let runtimeClientEventsGeneration = 0

    unsubs.push(attachMobileMarkdownBridge())

    const handleWorktreesChanged = async (
      repoId: string,
      renamed?: { oldWorktreeId: string; newWorktreeId: string }
    ): Promise<void> => {
      // Why: a folder rename changes the worktree's path-derived id. Re-key every
      // worktree-scoped map to the new id BEFORE the deletion diff below so the
      // rename is not mistaken for a deletion that would tear down the live
      // worktree. Capture active-ness before migrating (which moves the pointer).
      const renamedWasActive =
        renamed != null && useAppStore.getState().activeWorktreeId === renamed.oldWorktreeId
      if (renamed) {
        // Shield both ids from the deletion diff across the rename's event burst
        // (any event, any order) — the worktree list lags the on-disk move.
        const expiry = Date.now() + WORKTREE_RENAME_PURGE_GRACE_MS
        recentlyRenamedWorktreeIdExpiry.set(renamed.oldWorktreeId, expiry)
        recentlyRenamedWorktreeIdExpiry.set(renamed.newWorktreeId, expiry)
        useAppStore.getState().migrateWorktreeIdentity(renamed.oldWorktreeId, renamed.newWorktreeId)
      }
      // Why: diff before vs. after fetchWorktrees to detect server-side
      // deletions (CLI `orca worktree rm`, other window, out-of-band RPC)
      // and purge worktree-scoped state for removed ids. Without this,
      // `ptyIdsByTabId` would retain entries for tabs whose worktree is
      // gone, and SessionsStatusSegment's `boundPtyIds` set would keep
      // misclassifying the zombie as bound (design §2c, §4.4).
      const state = useAppStore.getState()
      const before =
        getAuthoritativeDetectedWorktreeIds(state, repoId) ??
        getVisibleWorktreeIdsForRepo(state, repoId)
      await state.fetchWorktrees(repoId)
      await useAppStore.getState().fetchWorktreeLineage()
      // Why: changing the worktree's id unmounts the active pane without
      // re-rendering it under the new id. Now that the list has refreshed,
      // re-activate the renamed worktree so its tab model reconciles and the
      // pane reconnects — otherwise the tab vanishes until manual re-selection.
      if (renamedWasActive && renamed) {
        useAppStore.getState().setActiveWorktree(renamed.newWorktreeId)
      }
      const afterState = useAppStore.getState()
      const after = getAuthoritativeDetectedWorktreeIds(afterState, repoId)
      if (!after) {
        return
      }
      const now = Date.now()
      const removed: string[] = []
      for (const id of before) {
        if (after.has(id)) {
          continue
        }
        // A recently renamed worktree's old/new id is not a deletion — its
        // state moved (or is moving) to the new id; the list just lags.
        const graceExpiry = recentlyRenamedWorktreeIdExpiry.get(id)
        if (graceExpiry != null && graceExpiry > now) {
          continue
        }
        removed.push(id)
      }
      for (const [id, expiry] of recentlyRenamedWorktreeIdExpiry) {
        if (expiry <= now) {
          recentlyRenamedWorktreeIdExpiry.delete(id)
        }
      }
      if (removed.length > 0) {
        console.warn(
          `[worktree-purge] diff-based purge removing state for ${removed.length} worktree(s):`,
          removed
        )
        afterState.purgeWorktreeTerminalState(removed)
        afterState.removeWorkspaceSpaceWorktrees(removed)
      }
    }

    const activateNotifiedWorktree = async (
      {
        repoId,
        worktreeId,
        setup,
        startup,
        defaultTabs
      }: Extract<RuntimeClientEvent, { type: 'activateWorktree' }>,
      options: { allowRuntimeEnvironment: boolean }
    ): Promise<void> => {
      if (!options.allowRuntimeEnvironment && isRuntimeEnvironmentActive()) {
        // Why: local CLI-created worktree events carry local repo/worktree
        // ids. Runtime server activation arrives through the remote event
        // stream and is allowed through this helper separately.
        return
      }
      const existedBeforeFetch = Boolean(useAppStore.getState().getKnownWorktreeById(worktreeId))
      // Why: fetch worktrees first so the activation helper can resolve
      // the CLI-created worktree via findWorktreeById — it arrived from
      // the main process and is not yet in the renderer state.
      await useAppStore.getState().fetchWorktrees(repoId)
      const existsAfterFetch = Boolean(useAppStore.getState().getKnownWorktreeById(worktreeId))
      // Why: route through activateAndRevealWorktree so CLI-created
      // worktrees share the canonical activation path with UI-created
      // ones. This records the visit in the back/forward history stack
      // (recordWorktreeVisit), without which the nav buttons would
      // ignore the CLI-driven workspace switch.
      activateAndRevealWorktree(worktreeId, {
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        ...(!existedBeforeFetch && existsAfterFetch ? { sidebarRevealBehavior: 'auto' } : {}),
        // Why: this activation already came from the host runtime event stream.
        // Echoing it back as worktree.activate can create a selection loop.
        notifyHostRuntime: false
      })
    }

    const ensureRuntimeEventRepoKnown = async (
      environmentId: string,
      repoId: string
    ): Promise<void> => {
      if ((useAppStore.getState().repos ?? []).some((repo) => repo.id === repoId)) {
        return
      }
      await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
    }

    const handleRuntimeClientEvent = (environmentId: string, event: RuntimeClientEvent): void => {
      if (event.type === 'reposChanged') {
        const state = useAppStore.getState()
        void state.fetchRuntimeEnvironmentRepos(environmentId).then(async (repos) => {
          await Promise.all(repos.map((repo) => useAppStore.getState().fetchWorktrees(repo.id)))
          await useAppStore.getState().fetchWorktreeLineage()
        })
        return
      }
      if (event.type === 'worktreesChanged') {
        void ensureRuntimeEventRepoKnown(environmentId, event.repoId).then(() =>
          handleWorktreesChanged(event.repoId)
        )
        return
      }
      if (event.type === 'linearLinkedIssueUpdated') {
        void useAppStore
          .getState()
          .refreshLinearIssue(event.identifier, event.workspaceId)
          .catch((error) => {
            console.error('Failed to refresh updated Linear issue:', error)
          })
        return
      }
      void ensureRuntimeEventRepoKnown(environmentId, event.repoId)
        .then(() => activateNotifiedWorktree(event, { allowRuntimeEnvironment: true }))
        .catch((error) => {
          console.error('Failed to activate runtime-created worktree:', error)
        })
    }

    const stopRuntimeClientEvents = (): void => {
      runtimeClientEventsGeneration += 1
      for (const unsubscribe of runtimeClientEventsSubscriptions.values()) {
        unsubscribe()
      }
      runtimeClientEventsSubscriptions.clear()
      runtimeClientEventsPending.clear()
    }

    const syncRuntimeClientEventsSubscription = (): void => {
      const desiredIds = new Set(getRuntimeClientEventEnvironmentIds())
      for (const [environmentId, unsubscribe] of runtimeClientEventsSubscriptions) {
        if (desiredIds.has(environmentId)) {
          continue
        }
        unsubscribe()
        runtimeClientEventsSubscriptions.delete(environmentId)
      }
      for (const environmentId of desiredIds) {
        if (
          runtimeClientEventsSubscriptions.has(environmentId) ||
          runtimeClientEventsPending.has(environmentId)
        ) {
          continue
        }
        runtimeClientEventsPending.add(environmentId)
        const generation = runtimeClientEventsGeneration
        void subscribeRuntimeClientEvents(
          environmentId,
          (event) => handleRuntimeClientEvent(environmentId, event),
          (error) => {
            console.warn('[runtime-client-events] subscription error:', error)
          }
        )
          .then((subscription) => {
            runtimeClientEventsPending.delete(environmentId)
            if (
              generation !== runtimeClientEventsGeneration ||
              !getRuntimeClientEventEnvironmentIds().includes(environmentId)
            ) {
              subscription.unsubscribe()
              return
            }
            runtimeClientEventsSubscriptions.set(environmentId, subscription.unsubscribe)
          })
          .catch((error) => {
            runtimeClientEventsPending.delete(environmentId)
            if (generation === runtimeClientEventsGeneration) {
              console.warn('[runtime-client-events] failed to subscribe:', error)
            }
          })
      }
      for (const environmentId of runtimeClientEventsPending) {
        if (desiredIds.has(environmentId)) {
          continue
        }
        runtimeClientEventsPending.delete(environmentId)
      }
      if (desiredIds.size === 0 && runtimeClientEventsSubscriptions.size === 0) {
        runtimeClientEventsGeneration += 1
      }
    }

    const unsubscribeRuntimeClientEventsSubscription = (): void => {
      stopRuntimeClientEvents()
    }

    syncRuntimeClientEventsSubscription()
    unsubs.push(useAppStore.subscribe(syncRuntimeClientEventsSubscription))
    unsubs.push(unsubscribeRuntimeClientEventsSubscription)

    unsubs.push(
      window.api.repos.onChanged(() => {
        if (isRuntimeEnvironmentActive()) {
          // Why: this event comes from the local Electron store. While a
          // runtime server is selected, repo hydration must be driven by the
          // selected server instead of local-disk changes.
          return
        }
        const state = useAppStore.getState()
        void state.fetchProjectGroups()
        void state.fetchFolderWorkspaces()
        void state.fetchRepos()
      })
    )

    unsubs.push(
      window.api.worktrees.onChanged(
        async (data: {
          repoId: string
          renamed?: { oldWorktreeId: string; newWorktreeId: string }
        }) => {
          if (isRuntimeEnvironmentActive()) {
            // Why: local worktree events carry local repo ids. Fetching the
            // active runtime with those ids can purge or overwrite server state.
            return
          }
          // A folder rename changes the worktree id; handleWorktreesChanged
          // re-keys state and shields it from the deletion diff (see there).
          await handleWorktreesChanged(data.repoId, data.renamed)
        }
      )
    )

    unsubs.push(
      window.api.worktrees.onBaseStatus((event) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        useAppStore.getState().updateWorktreeBaseStatus(event)
      })
    )

    unsubs.push(
      window.api.worktrees.onRemoteBranchConflict((event) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        useAppStore.getState().updateWorktreeRemoteBranchConflict(event)
      })
    )

    // Why: drive each background creation's status panel by routing the main
    // process's two-phase progress to its pending entry via the correlation id.
    // Guarded with `?.` so a stale preload bundle doesn't crash the listener set.
    unsubs.push(
      window.api.worktrees.onCreateProgress?.((data) => {
        if (!data.creationId) {
          return
        }
        useAppStore.getState().updatePendingWorktreeCreation(data.creationId, { phase: data.phase })
      }) ?? (() => {})
    )

    if (window.api.gh?.onPRRefreshEvent) {
      unsubs.push(
        window.api.gh.onPRRefreshEvent((event) => {
          useAppStore.getState().applyGitHubPRRefreshEvent(event)
        })
      )
    }

    unsubs.push(
      window.api.ui.onOpenSettings(() => {
        useAppStore.getState().openSettingsPage()
      })
    )

    unsubs.push(
      window.api.ui.onOpenSetupGuide?.(() => {
        useAppStore.getState().openModal('setup-guide', { telemetrySource: 'help_menu' })
      }) ?? (() => {})
    )

    unsubs.push(
      window.api.ui.onOpenFeatureTour(() => {
        useAppStore.getState().openModal('feature-wall', { source: 'help_menu' })
      })
    )

    // Why: the View > Appearance menu toggles settings directly in main (so
    // checkbox state reflects the persisted value without a round-trip) and
    // broadcasts the change. Merge it into the store so the sidebar and
    // titlebar re-render immediately instead of waiting for the next
    // fetchSettings() call.
    unsubs.push(
      window.api.settings.onChanged((updates) => {
        const store = useAppStore.getState()
        if (!store.settings) {
          return
        }
        useAppStore.setState({
          settings: {
            ...store.settings,
            ...updates,
            notifications: {
              ...store.settings.notifications,
              ...updates.notifications
            }
          }
        })
      })
    )

    // Why: UI view-state (group/sort/filters, collapsed groups, etc.) is shared
    // with mobile via the ui.set RPC. When mobile changes it, main broadcasts so
    // the desktop re-hydrates and the sidebar reflects it live — bi-directional.
    unsubs.push(
      window.api.ui.onStateChanged((ui) => {
        useAppStore.getState().hydratePersistedUI(ui)
      })
    )

    if (window.api.keybindings) {
      unsubs.push(
        window.api.keybindings.onChanged((snapshot) => {
          useAppStore.getState().setKeybindingSnapshot(snapshot)
        })
      )
    }

    unsubs.push(
      window.api.ui.onToggleLeftSidebar(() => {
        useAppStore.getState().toggleSidebar()
      })
    )

    unsubs.push(
      window.api.ui.onToggleRightSidebar(() => {
        const store = useAppStore.getState()
        if (!canShowRightSidebarForView(store.activeView)) {
          return
        }
        store.toggleRightSidebar()
      })
    )

    unsubs.push(
      window.api.ui.onToggleWorktreePalette(() => {
        const store = useAppStore.getState()
        if (store.activeModal === 'worktree-palette') {
          store.closeModal()
          return
        }
        store.openModal('worktree-palette')
      })
    )

    unsubs.push(
      window.api.ui.onToggleFloatingTerminal(() => {
        window.dispatchEvent(new CustomEvent(TOGGLE_FLOATING_TERMINAL_EVENT))
      })
    )

    if (window.api.ui.onTerminalShortcutCaptured) {
      unsubs.push(
        window.api.ui.onTerminalShortcutCaptured(({ actionId }) => {
          showTerminalShortcutCaptureNotification({
            actionId,
            platform: getShortcutPlatform(),
            keybindings: useAppStore.getState().keybindings
          })
        })
      )
    }

    unsubs.push(
      window.api.ui.onOpenQuickOpen(() => {
        const store = useAppStore.getState()
        if (store.activeView === 'terminal' && store.activeWorktreeId !== null) {
          store.openModal('quick-open')
        }
      })
    )

    unsubs.push(
      window.api.ui.onOpenNewWorkspace(() => {
        const store = useAppStore.getState()
        openNewWorkspaceFromShortcut(store)
      })
    )

    if (window.api.ui.onDeleteCurrentWorkspace) {
      unsubs.push(
        window.api.ui.onDeleteCurrentWorkspace(() => {
          const store = useAppStore.getState()
          if (
            store.activeModal !== 'none' ||
            store.activeView !== 'terminal' ||
            !store.activeWorktreeId
          ) {
            return
          }
          runWorktreeDelete(store.activeWorktreeId)
        })
      )
    }

    if (window.api.ui.onOpenWorkspaceBoard) {
      unsubs.push(
        window.api.ui.onOpenWorkspaceBoard(() => {
          const store = useAppStore.getState()
          if (store.activeView === 'settings') {
            return
          }
          store.setSidebarOpen(true)
          window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_BOARD_EVENT))
        })
      )
    }

    unsubs.push(
      window.api.ui.onOpenTasks(() => {
        const store = useAppStore.getState()
        if (store.activeView === 'settings' || !store.repos.some((repo) => isGitRepoKind(repo))) {
          return
        }
        store.openTaskPage()
      })
    )

    unsubs.push(
      window.api.ui.onJumpToWorktreeIndex((index) => {
        const store = useAppStore.getState()
        if (store.activeView !== 'terminal') {
          return
        }
        const visibleIds = getVisibleWorktreeIds()
        if (index < visibleIds.length) {
          activateAndRevealWorktree(visibleIds[index])
        }
      })
    )

    unsubs.push(
      window.api.ui.onJumpToTabIndex((index) => {
        activateTabNumberShortcut(index)
      })
    )

    unsubs.push(
      window.api.ui.onWorktreeHistoryNavigate((direction) => {
        const store = useAppStore.getState()
        // Why: mirror the button-visibility rule — worktree history navigation
        // is only meaningful in the terminal (worktree) view. Settings/Tasks
        // transitions aren't worktree activations and the buttons are hidden,
        // so the shortcut no-ops there too.
        if (store.activeView !== 'terminal') {
          return
        }
        if (direction === 'back') {
          store.goBackWorktree()
        } else {
          store.goForwardWorktree()
        }
      })
    )

    unsubs.push(
      window.api.ui.onToggleStatusBar(() => {
        const store = useAppStore.getState()
        store.setStatusBarVisible(!store.statusBarVisible)
      })
    )

    unsubs.push(
      window.api.ui.onActivateWorktree(({ repoId, worktreeId, setup, startup, defaultTabs }) => {
        void activateNotifiedWorktree(
          {
            type: 'activateWorktree',
            repoId,
            worktreeId,
            ...(setup ? { setup } : {}),
            ...(startup ? { startup } : {}),
            ...(defaultTabs ? { defaultTabs } : {})
          },
          { allowRuntimeEnvironment: false }
        ).catch((error) => {
          console.error('Failed to activate CLI-created worktree:', error)
        })
      })
    )

    unsubs.push(
      window.api.ui.onCreateTerminal(
        ({
          requestId,
          worktreeId,
          command,
          title,
          ptyId,
          activate,
          tabId,
          leafId,
          splitFromLeafId,
          splitDirection,
          splitTelemetrySource
        }) => {
          try {
            if (isRuntimeEnvironmentActive()) {
              if (requestId) {
                window.api.ui.replyTerminalCreate({
                  requestId,
                  error: translate(
                    'auto.hooks.useIpcEvents.60428567b4',
                    'Local terminal reveal is unavailable while a remote runtime is active'
                  )
                })
              }
              return
            }
            const store = useAppStore.getState()
            const shouldActivate = activate !== false
            if (shouldActivate) {
              store.setActiveView('terminal')
              store.setActiveWorktree(worktreeId)
              // Why: CLI-driven terminal focus is a user-initiated worktree switch
              // and must stamp focus recency for Cmd+J. Doesn't route through
              // activateAndRevealWorktree because it has custom terminal-creation
              // logic; see docs/cmd-j-empty-query-ordering.md.
              store.markWorktreeVisited(worktreeId)
            }
            const existingTab = ptyId
              ? (store.tabsByWorktree[worktreeId] ?? []).find(
                  (candidate) =>
                    candidate.ptyId === ptyId ||
                    (store.ptyIdsByTabId[candidate.id] ?? []).includes(ptyId)
                )
              : undefined
            const isSplitReveal = Boolean(ptyId && tabId && leafId && splitFromLeafId)
            const splitTargetTab = isSplitReveal
              ? (store.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
              : undefined
            if (isSplitReveal && !splitTargetTab) {
              throw new Error(`Terminal tab ${tabId} not found`)
            }
            const reusedTab = existingTab ?? splitTargetTab
            const tab =
              reusedTab ??
              (ptyId
                ? store.createTab(worktreeId, undefined, undefined, {
                    initialPtyId: ptyId,
                    activate: shouldActivate,
                    // Why: tabId hint comes from CLI-spawned PTYs whose env
                    // already has the pane key baked in. Adopting the tab under
                    // the same id keeps hook-event attribution working.
                    ...(tabId !== undefined ? { id: tabId } : {})
                  })
                : store.createTab(worktreeId))
            // Why: when an existing tab already owns this ptyId, we reuse it instead of
            // minting a new one — but the PTY env already carries a paneKey from main.
            // If the existing tab id doesn't match the hint, hook attribution degrades
            // for that PTY's lifetime. Warn so this is visible during development.
            if (tabId !== undefined && tab.id !== tabId) {
              console.warn(
                `[onCreateTerminal] tabId hint ${tabId} ignored for ptyId ${ptyId}; existing tab ${tab.id} adopted instead (hook attribution will degrade for this terminal)`
              )
            }
            if (shouldActivate) {
              store.setActiveTabType('terminal')
              store.setActiveTab(tab.id)
              store.revealWorktreeInSidebar(worktreeId)
            }
            // Why: only stamp the runtime-supplied title on freshly created tabs.
            // Existing tabs may have a user customTitle (set via UI rename) that
            // the runtime's stored title would otherwise silently overwrite on
            // every focus.
            if (title && !reusedTab) {
              store.setTabCustomTitle(tab.id, title, { recordInteraction: false })
            }
            if (leafId && ptyId) {
              if (splitFromLeafId) {
                // Why: runtime-spawned split PTYs already carry the parent tab's
                // paneKey. Reusing the existing tab preserves native split-pane
                // behavior instead of letting createTab mint a collision tab.
                store.updateTabPtyId(tab.id, ptyId)
                const existingLayout = store.terminalLayoutsByTabId?.[tab.id]
                const sourcePtyId = existingLayout?.ptyIdsByLeafId?.[splitFromLeafId]
                store.setTabLayout(
                  tab.id,
                  addSplitLeafToLayout(
                    existingLayout,
                    splitFromLeafId,
                    leafId,
                    ptyId,
                    splitDirection ?? 'horizontal',
                    title,
                    shouldActivate
                  )
                )
                window.dispatchEvent(
                  new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, {
                    detail: {
                      tabId: tab.id,
                      paneRuntimeId: -1,
                      direction: splitDirection ?? 'horizontal',
                      sourceLeafId: splitFromLeafId,
                      sourcePtyId,
                      telemetrySource: splitTelemetrySource,
                      newLeafId: leafId,
                      ptyId
                    }
                  })
                )
              } else {
                // Why: CLI/runtime-spawned PTYs emit hook events before a hidden
                // tab mounts TerminalPane, so the adopted UUID leaf must exist
                // in layout state for paneKey validation to accept them.
                const existingLayout = reusedTab
                  ? activateExistingLeafInLayout(
                      store.terminalLayoutsByTabId?.[tab.id],
                      leafId,
                      ptyId,
                      title
                    )
                  : null
                if (existingLayout) {
                  store.updateTabPtyId(tab.id, ptyId)
                  store.setTabLayout(tab.id, existingLayout)
                } else {
                  store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId, title))
                }
              }
            }
            if (command) {
              store.queueTabStartupCommand(tab.id, { command })
            }
            if (requestId) {
              window.api.ui.replyTerminalCreate({
                requestId,
                tabId: tab.id,
                title: title ?? tab.title
              })
            }
          } catch (err) {
            if (!requestId) {
              throw err
            }
            window.api.ui.replyTerminalCreate({
              requestId,
              error: err instanceof Error ? err.message : 'Terminal reveal failed'
            })
          }
        }
      )
    )

    // Why: CLI-driven terminal creation sends a request and waits for the
    // tabId reply so it can resolve a handle the caller can use immediately.
    // This mirrors the browser's onRequestTabCreate/replyTabCreate pattern.
    unsubs.push(
      window.api.ui.onRequestTerminalCreate((data) => {
        try {
          if (isRuntimeEnvironmentActive()) {
            window.api.ui.replyTerminalCreate({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.7a64b31991',
                'Local terminal creation is unavailable while a remote runtime is active'
              )
            })
            return
          }
          const store = useAppStore.getState()
          const worktreeId = data.worktreeId ?? store.activeWorktreeId
          if (!worktreeId) {
            window.api.ui.replyTerminalCreate({
              requestId: data.requestId,
              error: translate('auto.hooks.useIpcEvents.f000b2ff76', 'No active worktree')
            })
            return
          }
          const shouldActivate = data.activate !== false
          if (shouldActivate) {
            store.setActiveView('terminal')
            store.setActiveWorktree(worktreeId)
            // Why: CLI-driven focused terminal-create requests are user-initiated
            // worktree switches; unfocused renderer-backed creates must not reorder Cmd+J.
            store.markWorktreeVisited(worktreeId)
          } else {
            // Why: renderer-backed Codex startup must mount a TerminalPane so the
            // PTY is born in the renderer, but it must not switch the active UI.
            window.dispatchEvent(
              new CustomEvent(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, {
                detail: { worktreeId }
              })
            )
          }
          const tab = store.createTab(
            worktreeId,
            data.targetGroupId,
            undefined,
            shouldActivate ? undefined : { activate: false, recordInteraction: false }
          )
          if (data.afterTabId) {
            const createdUnifiedTab = useAppStore
              .getState()
              .unifiedTabsByWorktree[worktreeId]?.find((item) => item.entityId === tab.id)
            const anchorUnifiedTab = useAppStore
              .getState()
              .unifiedTabsByWorktree[worktreeId]?.find((item) => item.id === data.afterTabId)
            if (
              createdUnifiedTab &&
              anchorUnifiedTab &&
              createdUnifiedTab.groupId === anchorUnifiedTab.groupId
            ) {
              const group = useAppStore
                .getState()
                .groupsByWorktree[worktreeId]?.find((item) => item.id === createdUnifiedTab.groupId)
              const order = (group?.tabOrder ?? []).filter((id) => id !== createdUnifiedTab.id)
              const anchorIndex = order.indexOf(anchorUnifiedTab.id)
              order.splice(
                anchorIndex === -1 ? order.length : anchorIndex + 1,
                0,
                createdUnifiedTab.id
              )
              useAppStore.getState().reorderUnifiedTabs(createdUnifiedTab.groupId, order, {
                recordInteraction: false
              })
            }
          }
          if (shouldActivate) {
            store.setActiveTabType('terminal')
            store.setActiveTab(tab.id)
            store.revealWorktreeInSidebar(worktreeId)
          }
          if (data.title) {
            store.setTabCustomTitle(tab.id, data.title, { recordInteraction: false })
          }
          if (data.command) {
            store.queueTabStartupCommand(tab.id, {
              command: data.command,
              ...(data.startupCommandDelivery
                ? { startupCommandDelivery: data.startupCommandDelivery }
                : {})
            })
          }
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            tabId: tab.id,
            title: data.title ?? tab.title
          })
        } catch (err) {
          window.api.ui.replyTerminalCreate({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Terminal creation failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onSplitTerminal(
        ({ tabId, paneRuntimeId, direction, command, telemetrySource }) => {
          const detail: SplitTerminalPaneDetail = {
            tabId,
            paneRuntimeId,
            direction,
            command,
            telemetrySource
          }
          window.dispatchEvent(new CustomEvent(SPLIT_TERMINAL_PANE_EVENT, { detail }))
        }
      )
    )

    unsubs.push(
      window.api.ui.onRenameTerminal(({ tabId, title }) => {
        useAppStore.getState().setTabCustomTitle(tabId, title)
      })
    )

    unsubs.push(
      window.api.ui.onFocusTerminal(
        ({
          tabId,
          worktreeId,
          leafId,
          ackPaneKeyOnSuccess,
          flashFocusedPane,
          scrollToBottomIfOutputSinceLastView
        }) => {
          const store = useAppStore.getState()
          store.setActiveWorktree(worktreeId)
          // Why: CLI-driven focus is a user-initiated switch; stamp focus
          // recency for Cmd+J. See docs/cmd-j-empty-query-ordering.md.
          store.markWorktreeVisited(worktreeId)
          store.setActiveView('terminal')
          store.setActiveTab(tabId)
          store.revealWorktreeInSidebar(worktreeId)
          if (ackPaneKeyOnSuccess || flashFocusedPane || scrollToBottomIfOutputSinceLastView) {
            activateTabAndFocusPane(tabId, leafId ?? null, {
              ...(ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess } : {}),
              ...(flashFocusedPane ? { flashFocusedPane: true } : {}),
              ...(scrollToBottomIfOutputSinceLastView
                ? { scrollToBottomIfOutputSinceLastView: true }
                : {})
            })
            return
          }
          if (!focusRuntimeTerminalSurface(tabId, leafId)) {
            focusTerminalTabSurface(tabId, leafId)
          }
        }
      )
    )

    unsubs.push(
      window.api.ui.onFocusEditorTab(({ tabId, worktreeId }) => {
        const store = useAppStore.getState()
        const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (item) => item.id === tabId
        )
        const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
        if (!tab) {
          if (browserTarget) {
            // Why: older/mobile fallback snapshots can identify browser tabs
            // by workspace id when no unified tab wrapper exists.
            store.setActiveWorktree(worktreeId)
            store.markWorktreeVisited(worktreeId)
            store.setActiveView('terminal')
            store.setActiveBrowserTab(browserTarget.workspaceId)
            store.setActiveTabType('browser')
            store.revealWorktreeInSidebar(worktreeId)
          }
          return
        }
        store.setActiveWorktree(worktreeId)
        store.markWorktreeVisited(worktreeId)
        store.setActiveView('terminal')
        store.focusGroup(worktreeId, tab.groupId)
        store.activateTab(tab.id)
        if (browserTarget) {
          // Why: mobile session tabs reuse this IPC for renderer-owned
          // unified tabs. Browser tabs need their own active-page state,
          // not the editor file activation path.
          store.setActiveBrowserTab(browserTarget.workspaceId)
          store.setActiveTabType('browser')
        } else {
          store.setActiveFile(tab.entityId)
          store.setActiveTabType('editor')
        }
        store.revealWorktreeInSidebar(worktreeId)
      })
    )

    unsubs.push(
      window.api.ui.onCloseSessionTab(({ tabId, worktreeId }) => {
        const store = useAppStore.getState()
        const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
        if (browserTarget) {
          guardPinnedTabClose({
            isPinned: isPinnedSessionTab(store, worktreeId, browserTarget.workspaceId),
            tabLabel: resolvePinnedTabLabel(store, worktreeId, browserTarget.workspaceId),
            onClose: () => useAppStore.getState().closeBrowserTab(browserTarget.workspaceId)
          })
          return
        }
        guardPinnedTabClose({
          isPinned: isPinnedSessionTab(store, worktreeId, tabId),
          tabLabel: resolvePinnedTabLabel(store, worktreeId, tabId),
          onClose: () => useAppStore.getState().closeUnifiedTab(tabId)
        })
      })
    )

    unsubs.push(
      window.api.ui.onMoveSessionTab((move) => {
        const { tabId, targetGroupId } = move
        const store = useAppStore.getState()
        if (move.kind === 'reorder') {
          store.reorderUnifiedTabs(targetGroupId, move.tabOrder)
          return
        }
        store.dropUnifiedTab(tabId, {
          groupId: targetGroupId,
          ...(move.kind === 'move-to-group' ? { index: move.index } : {}),
          ...(move.kind === 'split' ? { splitDirection: move.splitDirection } : {})
        })
      })
    )

    unsubs.push(
      window.api.ui.onOpenFileFromMobile(
        ({ worktreeId, filePath, relativePath, runtimeEnvironmentId }) => {
          const store = useAppStore.getState()
          const basename = relativePath.split(/[\\/]/).pop() || relativePath
          store.setActiveWorktree(worktreeId)
          store.markWorktreeVisited(worktreeId)
          store.setActiveView('terminal')
          // Why: mobile only sends a desktop-backed path. The renderer owns
          // editor tab creation so grouped tab order and markdown bridges update
          // through the same store path as desktop File Explorer.
          store.openFile({
            filePath,
            relativePath,
            worktreeId,
            language: detectLanguage(basename),
            runtimeEnvironmentId,
            mode: 'edit'
          })
          store.setActiveTabType('editor')
          store.revealWorktreeInSidebar(worktreeId)
        }
      )
    )

    unsubs.push(
      window.api.ui.onOpenDiffFromMobile(
        ({ worktreeId, filePath, relativePath, staged, runtimeEnvironmentId }) => {
          const store = useAppStore.getState()
          const language = detectLanguage(relativePath)
          store.setActiveWorktree(worktreeId)
          store.markWorktreeVisited(worktreeId)
          store.setActiveView('terminal')
          // Why: mobile renders diff tabs from diff metadata. The desktop
          // markdown Changes-mode shortcut is editor-local and would publish
          // plain markdown content back to mobile.
          store.openDiff(worktreeId, filePath, relativePath, language, staged, {
            runtimeEnvironmentId
          })
          store.setActiveTabType('editor')
          store.revealWorktreeInSidebar(worktreeId)
        }
      )
    )

    unsubs.push(
      window.api.ui.onCloseTerminal(({ tabId, paneRuntimeId }) => {
        if (paneRuntimeId != null) {
          // Why: when targeting a specific pane in a split layout, dispatch to the
          // lifecycle hook so PaneManager.closePane() handles sibling promotion.
          // The lifecycle hook falls through to closeTab() if this is the last pane.
          const detail: CloseTerminalPaneDetail = { tabId, paneRuntimeId }
          window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
        } else {
          closeTerminalTab(tabId)
        }
      })
    )

    unsubs.push(
      window.api.ui.onSleepWorktree(({ worktreeId }) => {
        void runSleepWorktree(worktreeId)
      })
    )

    // Hydrate initial update status then subscribe to changes
    window.api.updater.getStatus().then((status) => {
      useAppStore.getState().setUpdateStatus(status as UpdateStatus)
    })

    unsubs.push(
      window.api.updater.onStatus((raw) => {
        const status = raw as UpdateStatus
        useAppStore.getState().setUpdateStatus(status)
      })
    )

    unsubs.push(
      window.api.updater.onClearDismissal(() => {
        useAppStore.getState().clearDismissedUpdateVersion()
      })
    )

    unsubs.push(
      window.api.ui.onFullscreenChanged((isFullScreen) => {
        useAppStore.getState().setIsFullScreen(isFullScreen)
      })
    )

    unsubs.push(
      window.api.browser.onGuestLoadFailed(({ browserPageId, loadError }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        useAppStore.getState().updateBrowserPageState(browserPageId, {
          loading: false,
          loadError,
          canGoBack: false,
          canGoForward: false
        })
      })
    )

    // Why: agent-browser drives navigation via CDP, bypassing Electron's webview
    // event system. The renderer's did-navigate listener never fires for those
    // navigations, so the Zustand store (address bar, tab title) stays stale.
    // This IPC pushes the live URL/title from main after goto/click/back/reload.
    unsubs.push(
      window.api.browser.onNavigationUpdate(({ browserPageId, url, title }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        const store = useAppStore.getState()
        store.setBrowserPageUrl(browserPageId, url)
        store.updateBrowserPageState(browserPageId, { title, loading: false })
      })
    )

    // Why: browser webviews only start their guest process when the container
    // has display != none. Main sends this before browser automation commands
    // so persisted hidden tabs mount without changing the user's active pane.
    unsubs.push(
      window.api.browser.onActivateView(({ worktreeId, browserPageId }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        acquireBrowserAutomationBootstrapLease(worktreeId, browserPageId)
      })
    )

    // Why: `orca tab switch --focus` lands here after the bridge's state-only
    // `tabSwitch`. We deliberately DO NOT call `setActiveWorktree` — multiple
    // agents drive browsers in parallel worktrees, so a global focus call from
    // one agent's tab switch would steal the user's view from whichever
    // worktree they're actually reading. Instead `focusBrowserTabInWorktree`
    // updates the targeted worktree's per-worktree state in place; globals
    // (activeBrowserTabId, activeTabType) only flip when the user is already
    // on the targeted worktree. Cross-worktree --focus calls are silent
    // pre-staging for whenever the user next visits that worktree.
    unsubs.push(
      window.api.browser.onPaneFocus(({ worktreeId, browserPageId }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        const store = useAppStore.getState()
        // Why: main sends `worktreeId: null` if the tab closed between the
        // bridge resolving tabSwitch and getWorktreeIdForTab running. Falling
        // back to activeWorktreeId means a stale page id in another worktree
        // is silently ignored by focusBrowserTabInWorktree (page not found
        // in its tabsForWorktree.find), which is the intended no-op.
        const targetWt = worktreeId ?? store.activeWorktreeId
        if (!targetWt) {
          return
        }
        store.focusBrowserTabInWorktree(targetWt, browserPageId)
      })
    )

    unsubs.push(
      window.api.browser.onOpenLinkInOrcaTab(({ browserPageId, url }) => {
        const store = useAppStore.getState()
        const sourcePage = Object.values(store.browserPagesByWorkspace)
          .flat()
          .find((page) => page.id === browserPageId)
        if (!sourcePage) {
          return
        }
        if (getRuntimeEnvironmentIdForWorktree(store, sourcePage.worktreeId)) {
          return
        }
        // Why: the guest process can request "open this link in Orca", but it
        // does not own Orca's worktree/tab model. Resolve the source page's
        // worktree and create a new outer browser tab so the link opens as a
        // separate tab in the outer Orca tab bar.
        store.createBrowserTab(sourcePage.worktreeId, url, { title: url })
      })
    )

    // Shortcut forwarding for embedded browser guests whose webContents
    // capture keyboard focus and bypass the renderer's window-level keydown.
    unsubs.push(
      window.api.ui.onNewBrowserTab(() => {
        const store = useAppStore.getState()
        if (isFloatingWorkspacePanelFocused()) {
          void createFloatingWorkspaceBrowserTab(store)
          return
        }
        const worktreeId = store.activeWorktreeId
        if (worktreeId) {
          const environmentId = getWorktreeRuntimeEnvironmentId(worktreeId)
          if (environmentId) {
            if (!isWebRuntimeSessionActive(environmentId)) {
              store.createBrowserTab(worktreeId, store.browserDefaultUrl ?? 'about:blank', {
                title: translate('auto.hooks.useIpcEvents.f6300deb8b', 'New Browser Tab'),
                focusAddressBar: true
              })
              return
            }
            void (async () => {
              // Why: paired web browser tabs are host-owned and arrive through
              // session.tabs. On RPC failure we leave local state unchanged so
              // the next host snapshot remains authoritative.
              await createWebRuntimeSessionBrowserTab({
                worktreeId,
                environmentId,
                url: store.browserDefaultUrl ?? 'about:blank'
              })
            })()
            return
          }
          store.createBrowserTab(worktreeId, store.browserDefaultUrl ?? 'about:blank', {
            title: translate('auto.hooks.useIpcEvents.f6300deb8b', 'New Browser Tab'),
            focusAddressBar: true
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onNewMarkdownTab(() => {
        const store = useAppStore.getState()
        if (isFloatingWorkspacePanelFocused()) {
          void createFloatingWorkspaceMarkdownTab(store).catch((err) => {
            toast.error(
              err instanceof Error
                ? err.message
                : translate(
                    'auto.hooks.useIpcEvents.56d3ec4203',
                    'Failed to create untitled markdown file.'
                  )
            )
          })
          return
        }
        const worktreeId = store.activeWorktreeId
        if (!worktreeId) {
          return
        }
        const targetGroupId =
          store.activeGroupIdByWorktree[worktreeId] ?? store.groupsByWorktree[worktreeId]?.[0]?.id
        if (targetGroupId) {
          void store.openNewMarkdownInActiveWorkspace(targetGroupId)
        }
      })
    )

    // Why: emulator IPC is additive. Older paired clients and partial test
    // preload mocks should not crash the whole event hook when it is absent.
    const unsubscribeNewSimulatorTab = window.api.ui.onNewSimulatorTab?.(() => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      const store = useAppStore.getState()
      const worktreeId = store.activeWorktreeId
      if (!worktreeId) {
        return
      }
      void openMobileEmulatorTab(worktreeId, { placement: 'rightSplit' })
    })
    if (unsubscribeNewSimulatorTab) {
      unsubs.push(unsubscribeNewSimulatorTab)
    }

    const unsubscribeEmulatorAutoAttach = window.api.emulator?.onAutoAttach(
      ({ worktreeId, info }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        if (isManualSimulatorLaunchPending(worktreeId)) {
          // Why: manual launches pre-attach first so the ready pane can be
          // created in the right split instead of as a hidden tab in this group.
          rememberPrelaunchedSimulatorSession(worktreeId, info)
          return
        }
        ensureSimulatorTab(worktreeId, { surfacePane: false })
        // Why: watcher may detect a helper while a simulator tab is already mounted; push stream info so the pane updates without re-attach.
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent('orca:emulator-auto-attach', {
              detail: { worktreeId, info }
            })
          )
        }, 0)
      }
    )
    if (unsubscribeEmulatorAutoAttach) {
      unsubs.push(unsubscribeEmulatorAutoAttach)
    }

    const unsubscribeEmulatorPaneFocus = window.api.emulator?.onPaneFocus(({ worktreeId }) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      ensureSimulatorTab(worktreeId, { surfacePane: true })
    })
    if (unsubscribeEmulatorPaneFocus) {
      unsubs.push(unsubscribeEmulatorPaneFocus)
    }

    // Why: CLI-driven tab creation sends a request with a specific worktreeId and
    // url. The renderer creates the tab and replies with the page ID so the
    // main process can wait for registerGuest before returning to the CLI.
    unsubs.push(
      window.api.ui.onRequestTabCreate((data) => {
        try {
          if (isRuntimeEnvironmentActive()) {
            // Why: browser automation targets client-local Electron webviews.
            // Runtime agents cannot see or control those surfaces.
            window.api.ui.replyTabCreate({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.291c8ed902',
                'Browser tabs are unavailable while a remote runtime is active'
              )
            })
            return
          }
          const store = useAppStore.getState()
          const worktreeId = data.worktreeId ?? store.activeWorktreeId
          if (!worktreeId) {
            window.api.ui.replyTabCreate({
              requestId: data.requestId,
              error: translate('auto.hooks.useIpcEvents.f000b2ff76', 'No active worktree')
            })
            return
          }
          // Why: CLI-created tabs should land in the same group as the active
          // browser tab, not the terminal's group (which is typically the
          // UI-active group when an agent is running commands).
          const activeBrowserTabId = store.activeBrowserTabIdByWorktree[worktreeId]
          const activeBrowserUnifiedTab = activeBrowserTabId
            ? (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
                (t) => t.contentType === 'browser' && t.entityId === activeBrowserTabId
              )
            : undefined

          // Why: a user-initiated open (data.activate, e.g. mobile tapping an HTML
          // path) foregrounds the tab so it lands in the active group's order and
          // publishes to mobile in the right place. Agent/automation opens stay in
          // the background (activate:false) in the active browser group.
          const workspace = store.createBrowserTab(worktreeId, data.url, {
            title: data.url,
            targetGroupId: data.activate ? undefined : activeBrowserUnifiedTab?.groupId,
            sessionProfileId: data.sessionProfileId,
            activate: data.activate === true
          })
          // Why: registerGuest fires with the page ID (not workspace ID) as
          // browserPageId. Return the page ID so waitForTabRegistration can
          // correlate correctly.
          const pages = useAppStore.getState().browserPagesByWorkspace[workspace.id] ?? []
          const browserPageId = pages[0]?.id ?? workspace.id
          acquireBrowserAutomationBootstrapLease(worktreeId, browserPageId)
          window.api.ui.replyTabCreate({ requestId: data.requestId, browserPageId })
        } catch (err) {
          window.api.ui.replyTabCreate({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Tab creation failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onRequestTabSetProfile((data) => {
        try {
          if (isRuntimeEnvironmentActive()) {
            window.api.ui.replyTabSetProfile({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.f45fa2b03c',
                'Browser profiles are unavailable while a remote runtime is active'
              )
            })
            return
          }
          const store = useAppStore.getState()
          const owningWorkspace = Object.values(store.browserTabsByWorktree)
            .flat()
            .find((workspace) => {
              if (workspace.id === data.browserPageId) {
                return true
              }
              const pages = store.browserPagesByWorkspace[workspace.id] ?? []
              return pages.some((page) => page.id === data.browserPageId)
            })
          if (!owningWorkspace) {
            window.api.ui.replyTabSetProfile({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.0e3cf53060',
                'Browser tab {{value0}} not found',
                { value0: data.browserPageId }
              )
            })
            return
          }
          // Why: a workspace can host multiple browser pages; profile switch must
          // tear down every sibling webview, not just the one referenced by the IPC.
          const workspacePages = store.browserPagesByWorkspace[owningWorkspace.id] ?? []
          if (workspacePages.length > 0) {
            for (const page of workspacePages) {
              destroyPersistentWebview(page.id)
            }
          } else {
            destroyPersistentWebview(data.browserPageId)
          }
          store.switchBrowserTabProfile(owningWorkspace.id, data.profileId)
          window.api.ui.replyTabSetProfile({ requestId: data.requestId })
        } catch (err) {
          window.api.ui.replyTabSetProfile({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Tab profile update failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onRequestTabClose((data) => {
        try {
          if (isRuntimeEnvironmentActive()) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.291c8ed902',
                'Browser tabs are unavailable while a remote runtime is active'
              )
            })
            return
          }
          const store = useAppStore.getState()
          const explicitTargetId = data.tabId ?? null
          const replyPinnedBrowserCloseCanceled = (tabId: string): void => {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.2f6637fe6c',
                'Browser tab {{value0}} is pinned',
                { value0: tabId }
              )
            })
          }
          const closeBrowserWorkspaceWithReply = (
            worktreeId: string,
            workspaceId: string
          ): void => {
            const currentStore = useAppStore.getState()
            guardPinnedTabClose({
              isPinned: isPinnedSessionTab(currentStore, worktreeId, workspaceId),
              tabLabel: resolvePinnedTabLabel(currentStore, worktreeId, workspaceId),
              onClose: () => {
                useAppStore.getState().closeBrowserTab(workspaceId)
                window.api.ui.replyTabClose({ requestId: data.requestId })
              },
              onCancel: () => replyPinnedBrowserCloseCanceled(workspaceId)
            })
          }
          const tabToClose =
            explicitTargetId ??
            (data.worktreeId
              ? (store.activeBrowserTabIdByWorktree?.[data.worktreeId] ?? null)
              : store.activeBrowserTabId)
          if (!tabToClose) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.a8d2bf8e9e',
                'No active browser tab to close'
              )
            })
            return
          }
          // Why: the bridge stores tabs keyed by browserPageId (which is the page
          // ID from registerGuest), but closeBrowserTab expects a workspace ID. If
          // tabToClose is a page ID, close only that page unless it is the
          // last page in its workspace. The CLI's `tab close --page` contract
          // targets one browser page, not the entire workspace tab.
          const isWorkspaceId = Object.values(store.browserTabsByWorktree)
            .flat()
            .some((ws) => ws.id === tabToClose)
          if (!isWorkspaceId) {
            const owningWorkspace = Object.entries(store.browserPagesByWorkspace).find(
              ([, pages]) => pages.some((p) => p.id === tabToClose)
            )
            if (owningWorkspace) {
              const [workspaceId, pages] = owningWorkspace
              if (pages.length <= 1) {
                const owningWorktreeId =
                  Object.entries(store.browserTabsByWorktree).find(([, tabs]) =>
                    tabs.some((tab) => tab.id === workspaceId)
                  )?.[0] ?? null
                if (owningWorktreeId) {
                  closeBrowserWorkspaceWithReply(owningWorktreeId, workspaceId)
                  return
                }
                store.closeBrowserTab(workspaceId)
              } else {
                store.closeBrowserPage(tabToClose)
              }
              window.api.ui.replyTabClose({ requestId: data.requestId })
              return
            }
          }
          const owningWorktreeId =
            Object.entries(store.browserTabsByWorktree).find(([, tabs]) =>
              tabs.some((tab) => tab.id === tabToClose)
            )?.[0] ?? null
          if (owningWorktreeId) {
            closeBrowserWorkspaceWithReply(owningWorktreeId, tabToClose)
            return
          }
          if (explicitTargetId) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: translate(
                'auto.hooks.useIpcEvents.0e3cf53060',
                'Browser tab {{value0}} not found',
                { value0: explicitTargetId }
              )
            })
            return
          }
          store.closeBrowserTab(tabToClose)
          window.api.ui.replyTabClose({ requestId: data.requestId })
        } catch (err) {
          window.api.ui.replyTabClose({
            requestId: data.requestId,
            error: err instanceof Error ? err.message : 'Tab close failed'
          })
        }
      })
    )

    unsubs.push(
      window.api.ui.onNewTerminalTab(() => {
        const store = useAppStore.getState()
        if (isFloatingWorkspacePanelFocused()) {
          void createFloatingWorkspaceTerminalTab(store)
          return
        }
        const worktreeId = store.activeWorktreeId
        if (!worktreeId) {
          return
        }
        void (async () => {
          if (
            await createWebRuntimeSessionTerminal({
              worktreeId,
              environmentId: getWorktreeRuntimeEnvironmentId(worktreeId),
              activate: true
            })
          ) {
            return
          }
          const newTab = store.createTab(worktreeId)
          store.setActiveTabType('terminal')
          // Why: replicate the full reconciliation from Terminal.tsx handleNewTab
          // so the new tab appends at the visual end instead of jumping to index 0
          // when tabBarOrderByWorktree is unset (e.g. restored worktrees).
          const freshStore = useAppStore.getState()
          const currentTerminals = freshStore.tabsByWorktree[worktreeId] ?? []
          const currentEditors = freshStore.openFiles.filter((f) => f.worktreeId === worktreeId)
          const currentBrowsers = freshStore.browserTabsByWorktree[worktreeId] ?? []
          const stored = freshStore.tabBarOrderByWorktree[worktreeId]
          const termIds = currentTerminals.map((t) => t.id)
          const editorIds = currentEditors.map((f) => f.id)
          const browserIds = currentBrowsers.map((tab) => tab.id)
          const validIds = new Set([...termIds, ...editorIds, ...browserIds])
          const base = (stored ?? []).filter((id) => validIds.has(id))
          const inBase = new Set(base)
          for (const id of [...termIds, ...editorIds, ...browserIds]) {
            if (!inBase.has(id)) {
              base.push(id)
              inBase.add(id)
            }
          }
          const order = base.filter((id) => id !== newTab.id)
          order.push(newTab.id)
          freshStore.setTabBarOrder(worktreeId, order)
          focusTerminalTabSurface(newTab.id)
        })()
      })
    )

    unsubs.push(
      window.api.ui.onCloseActiveTab(() => {
        if (isEmptyFloatingWorkspacePanelVisible()) {
          window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
          return
        }
        const store = useAppStore.getState()
        if (store.activeTabType === 'browser' && store.activeBrowserTabId) {
          const tabId = store.activeBrowserTabId
          const worktreeId = store.activeWorktreeId
          const closeActiveBrowserTab = (): void => {
            const currentStore = useAppStore.getState()
            const environmentId = getWorktreeRuntimeEnvironmentId(worktreeId)
            if (environmentId && worktreeId) {
              if (!isWebRuntimeSessionActive(environmentId)) {
                currentStore.closeBrowserTab(tabId)
                return
              }
              void closeWebRuntimeSessionTab({
                worktreeId,
                tabId,
                environmentId
              })
              return
            }
            currentStore.closeBrowserTab(tabId)
          }
          if (worktreeId && isPinnedSessionTab(store, worktreeId, tabId)) {
            guardPinnedTabClose({
              isPinned: true,
              tabLabel: resolvePinnedTabLabel(store, worktreeId, tabId),
              onClose: closeActiveBrowserTab
            })
            return
          }
          closeActiveBrowserTab()
        }
      })
    )

    unsubs.push(
      window.api.ui.onSwitchTab((direction) => {
        const store = useAppStore.getState()
        if (isFloatingWorkspacePanelFocused()) {
          switchFloatingWorkspaceTab(store, direction, 'same-type')
          return
        }
        handleSwitchTab(direction)
      })
    )
    unsubs.push(
      window.api.ui.onSwitchTabAcrossAllTypes((direction) => {
        const store = useAppStore.getState()
        if (isFloatingWorkspacePanelFocused()) {
          switchFloatingWorkspaceTab(store, direction, 'all-types')
          return
        }
        handleSwitchTabAcrossAllTypes(direction)
      })
    )
    unsubs.push(window.api.ui.onSwitchRecentTab(handleSwitchRecentTab))
    unsubs.push(
      window.api.ui.onSwitchTerminalTab((direction) => {
        const store = useAppStore.getState()
        if (isFloatingWorkspacePanelFocused()) {
          switchFloatingWorkspaceTab(store, direction, 'terminal')
          return
        }
        handleSwitchTerminalTab(direction)
      })
    )

    // Hydrate initial rate limit state then subscribe to push updates
    window.api.rateLimits.get().then((state) => {
      useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
    })

    unsubs.push(
      window.api.rateLimits.onUpdate((state) => {
        useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
      })
    )

    const unsubscribeWorkspaceSpaceProgress = window.api.workspaceSpace?.onProgress?.(
      (progress) => {
        useAppStore.getState().applyWorkspaceSpaceProgress(progress)
      }
    )
    if (unsubscribeWorkspaceSpaceProgress) {
      unsubs.push(unsubscribeWorkspaceSpaceProgress)
    }

    // Track SSH connection state changes so the renderer can show
    // disconnected indicators on remote worktrees.
    // Why: hydrate initial state for all known targets so worktree cards
    // reflect the correct connected/disconnected state on app launch.
    void (async () => {
      try {
        const targets = await window.api.ssh.listTargets()
        useAppStore.getState().setSshTargetsMetadata(targets)
        for (const target of targets) {
          const state = await window.api.ssh.getState({ targetId: target.id })
          if (state) {
            useAppStore.getState().setSshConnectionState(target.id, state as SshConnectionState)
            // Why: if the renderer reattaches while an SSH session is alive
            // (e.g. window re-creation or reload), forwarded and detected ports
            // are only populated via push events. Fetch current snapshots so the
            // Ports panel doesn't show empty for an active session.
            if ((state as SshConnectionState).status === 'connected') {
              const [forwards, detected] = await Promise.all([
                window.api.ssh.listPortForwards({ targetId: target.id }),
                window.api.ssh.listDetectedPorts({ targetId: target.id })
              ])
              // Why: if the session disconnected while we were awaiting the
              // snapshot, the disconnect handler already cleared port state.
              // Applying stale data here would resurrect a dead session's ports.
              const currentState = useAppStore.getState().sshConnectionStates.get(target.id)
              if (currentState?.status === 'connected') {
                useAppStore.getState().setPortForwards(target.id, forwards)
                useAppStore.getState().setDetectedPorts(target.id, detected)
              }
              void syncRemoteWorkspaceAfterConnect(target.id).catch((err) => {
                useAppStore.getState().setRemoteWorkspaceSyncStatus(target.id, {
                  phase: 'error',
                  message: err instanceof Error ? err.message : 'Workspace sync failed'
                })
              })
            }
          }
        }
      } catch {
        // SSH may not be configured
      }
    })()

    unsubs.push(
      window.api.ssh.onCredentialRequest((data) => {
        useAppStore.getState().enqueueSshCredentialRequest(data)
      })
    )

    unsubs.push(
      window.api.ssh.onCredentialResolved(({ requestId }) => {
        useAppStore.getState().removeSshCredentialRequest(requestId)
      })
    )

    unsubs.push(
      window.api.ssh.onPortForwardsChanged(({ targetId, forwards }) => {
        useAppStore.getState().setPortForwards(targetId, forwards)
      })
    )

    unsubs.push(
      window.api.ssh.onDetectedPortsChanged(({ targetId, ports }) => {
        useAppStore.getState().setDetectedPorts(targetId, ports)
      })
    )

    const applySshConnectionStateChange = (targetId: string, state: SshConnectionState): void => {
      const store = useAppStore.getState()
      store.setSshConnectionState(targetId, state)
      const remoteRepos = store.repos.filter((r) => r.connectionId === targetId)

      if (['disconnected', 'auth-failed', 'reconnection-failed', 'error'].includes(state.status)) {
        // Why: the remote agent list is tied to a live SSH connection. On
        // disconnect the relay is gone, so clear the cached list and dedup
        // promise. When the user reconnects and opens the quick-launch menu,
        // ensureRemoteDetectedAgents will re-detect against the new relay.
        store.clearRemoteDetectedAgents(targetId)

        // Why: defensive — clear port forward and detected port state in case
        // the broadcast from removeAllForwards races with the state change.
        store.clearPortForwards(targetId)
        store.setDetectedPorts(targetId, [])

        // Why: an explicit disconnect or terminal failure tears down the SSH
        // PTY provider without emitting per-PTY exit events. Clear the stale
        // PTY ids in renderer state so a later reconnect remounts TerminalPane
        // instead of keeping a dead remote PTY attached to the tab.
        const remoteWorktreeIds = new Set(
          Object.values(store.worktreesByRepo)
            .flat()
            .filter((w) => remoteRepos.some((r) => r.id === w.repoId))
            .map((w) => w.id)
        )
        for (const worktreeId of remoteWorktreeIds) {
          const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
          for (const tab of tabs) {
            if (tab.ptyId) {
              useAppStore.getState().clearTabPtyId(tab.id)
            }
          }
        }
      }

      if (state.status === 'connected') {
        void Promise.all(remoteRepos.map((r) => store.fetchWorktrees(r.id))).then(async () => {
          await useAppStore.getState().fetchWorktreeLineage()
          // Why: terminal panes that failed to spawn (no PTY provider on cold
          // start) sit inert. Bumping generation forces TerminalPane to remount
          // and retry pty:spawn. Only bump tabs with no live ptyId.
          const freshStore = useAppStore.getState()
          const remoteRepoIds = new Set(remoteRepos.map((r) => r.id))
          const worktreeIds = Object.values(freshStore.worktreesByRepo)
            .flat()
            .filter((w) => remoteRepoIds.has(w.repoId))
            .map((w) => w.id)

          for (const worktreeId of worktreeIds) {
            const tabs = freshStore.tabsByWorktree[worktreeId] ?? []
            const hasDead = tabs.some((t) => !t.ptyId)
            if (hasDead) {
              useAppStore.setState((s) => ({
                tabsByWorktree: {
                  ...s.tabsByWorktree,
                  [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((t) =>
                    t.ptyId ? t : { ...t, generation: (t.generation ?? 0) + 1 }
                  )
                }
              }))
            }
          }
          void syncRemoteWorkspaceAfterConnect(targetId).catch((err) => {
            useAppStore.getState().setRemoteWorkspaceSyncStatus(targetId, {
              phase: 'error',
              message: err instanceof Error ? err.message : 'Workspace sync failed'
            })
          })
        })
      }
    }

    let sshTargetStateEventId = 0
    const latestSshTargetStateEventByTargetId = new Map<string, number>()

    unsubs.push(
      window.api.ssh.onStateChanged((data: { targetId: string; state: unknown }) => {
        const store = useAppStore.getState()
        const state = data.state as SshConnectionState
        const stateEventId = ++sshTargetStateEventId
        latestSshTargetStateEventByTargetId.set(data.targetId, stateEventId)
        if (!store.sshTargetLabels.has(data.targetId)) {
          // Why: targets added after boot aren't in the labels map, while
          // removed targets can still race a final disconnect event. Confirm
          // with main before mutating renderer state for an unknown target id.
          window.api.ssh
            .listTargets()
            // Why: this refresh is now a deletion guard, not just a label fetch.
            // Retry once so a transient IPC failure does not drop a real added-target event.
            .catch(() => window.api.ssh.listTargets())
            .then((targets) => {
              if (latestSshTargetStateEventByTargetId.get(data.targetId) !== stateEventId) {
                return
              }
              latestSshTargetStateEventByTargetId.delete(data.targetId)
              const latestStore = useAppStore.getState()
              if (!targets.some((target) => target.id === data.targetId)) {
                // Why: disconnect/state events can race after target removal.
                // Treat absence from main's target list as deletion, not a new target.
                latestStore.clearRemovedSshTargetState(data.targetId)
                return
              }
              latestStore.setSshTargetsMetadata(targets)
              applySshConnectionStateChange(data.targetId, state)
            })
            .catch(() => {
              if (latestSshTargetStateEventByTargetId.get(data.targetId) === stateEventId) {
                latestSshTargetStateEventByTargetId.delete(data.targetId)
                applySshConnectionStateChange(data.targetId, state)
              }
            })
          return
        }

        latestSshTargetStateEventByTargetId.delete(data.targetId)
        applySshConnectionStateChange(data.targetId, state)
      })
    )

    let remoteWorkspaceClientId: string | null = null
    let remoteWorkspaceClientIdPromise: Promise<string | null> | null = null
    const getRemoteWorkspaceClientId = (): Promise<string | null> => {
      const remoteWorkspace = window.api.remoteWorkspace
      if (!remoteWorkspace) {
        return Promise.resolve(null)
      }
      if (remoteWorkspaceClientId) {
        return Promise.resolve(remoteWorkspaceClientId)
      }
      remoteWorkspaceClientIdPromise ??= remoteWorkspace
        .clientId()
        .then((id) => {
          remoteWorkspaceClientId = id
          return id
        })
        .catch(() => null)
      return remoteWorkspaceClientIdPromise
    }
    if (window.api.remoteWorkspace) {
      void getRemoteWorkspaceClientId()
      unsubs.push(
        window.api.remoteWorkspace.onChanged((event) => {
          void (async () => {
            // Why: relay notifications can race the initial client-id IPC.
            // Self-originated writes must never bounce back into restore.
            const clientId = await getRemoteWorkspaceClientId()
            if (event.sourceClientId && clientId && event.sourceClientId === clientId) {
              return
            }
            await applyRemoteWorkspaceSnapshot(event.targetId, event.snapshot).catch((err) => {
              useAppStore.getState().setRemoteWorkspaceSyncStatus(event.targetId, {
                phase: 'error',
                revision: event.snapshot.revision,
                message: err instanceof Error ? err.message : 'Failed to apply remote workspace'
              })
            })
          })()
        })
      )
    }

    // Zoom handling for menu accelerators and keyboard fallback paths.
    unsubs.push(
      window.api.ui.onTerminalZoom((direction) => {
        const store = useAppStore.getState()
        const { activeView, activeTabType, editorFontZoomLevel, setEditorFontZoomLevel, settings } =
          store
        const activeBrowserPageId = resolveActiveBrowserPageId(store)
        const target = resolveZoomTarget({
          activeView,
          activeTabType,
          activeBrowserPageId,
          activeElement: document.activeElement
        })
        if (target === 'terminal') {
          return
        }
        if (target === 'browser') {
          if (!activeBrowserPageId) {
            return
          }
          dispatchBrowserPageZoomEvent({ browserPageId: activeBrowserPageId, direction })
          return
        }
        if (target === 'editor') {
          const next = nextEditorFontZoomLevel(editorFontZoomLevel, direction)
          setEditorFontZoomLevel(next)
          void window.api.ui.set({ editorFontZoomLevel: next })

          // Why: use the same base font size the editor surfaces use (terminalFontSize)
          // and computeEditorFontSize to account for clamping, so the overlay percent
          // matches the actual rendered size.
          const baseFontSize = settings?.terminalFontSize ?? 13
          const actual = computeEditorFontSize(baseFontSize, next)
          const percent = Math.round((actual / baseFontSize) * 100)
          dispatchZoomLevelChanged('editor', percent)
          return
        }

        const current = window.api.ui.getZoomLevel()
        const rawNext =
          direction === 'in' ? current + ZOOM_STEP : direction === 'out' ? current - ZOOM_STEP : 0
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, rawNext))

        applyUIZoom(next)
        void window.api.ui.set({ uiZoomLevel: next })

        dispatchZoomLevelChanged('ui', zoomLevelToPercent(next))
      })
    )

    // Why: agent status arrives from native hook receivers in the main process.
    // Re-parse it here so the renderer enforces the same normalization rules
    // (state enum, field truncation) regardless of whether the source was a
    // hook callback or an OSC fallback path. Startup pushes are ignored until
    // workspace session hydration finishes; the snapshot pull below replays the
    // main-process cache after tab identity is available.
    function schedulePendingAgentStatusFlush(): void {
      if (pendingAgentStatusRetryTimer !== null || pendingAgentStatusEvents.length === 0) {
        return
      }
      pendingAgentStatusRetryTimer = globalThis.setTimeout(() => {
        pendingAgentStatusRetryTimer = null
        flushPendingAgentStatuses()
      }, PENDING_AGENT_STATUS_RETRY_MS)
    }

    function enqueuePendingAgentStatus(data: AgentStatusIpcPayload): void {
      pendingAgentStatusEvents.push({ data, firstSeenAt: Date.now() })
      while (pendingAgentStatusEvents.length > MAX_PENDING_AGENT_STATUS_EVENTS) {
        pendingAgentStatusEvents.shift()
      }
      schedulePendingAgentStatusFlush()
    }

    function flushPendingAgentStatuses(): void {
      if (pendingAgentStatusEvents.length === 0) {
        return
      }
      const now = Date.now()
      const remaining: PendingAgentStatusEvent[] = []
      for (const event of pendingAgentStatusEvents) {
        if (now - event.firstSeenAt > PENDING_AGENT_STATUS_TTL_MS) {
          continue
        }
        const result = applyAgentStatus(event.data, { retry: true })
        if (result === 'pending') {
          remaining.push(event)
        }
      }
      pendingAgentStatusEvents.length = 0
      pendingAgentStatusEvents.push(...remaining)
      if (pendingAgentStatusEvents.length === 0 && pendingAgentStatusRetryTimer !== null) {
        globalThis.clearTimeout(pendingAgentStatusRetryTimer)
        pendingAgentStatusRetryTimer = null
      }
      schedulePendingAgentStatusFlush()
    }

    const applyAgentStatus = (
      data: AgentStatusIpcPayload,
      options?: { replay?: boolean; retry?: boolean }
    ): AgentStatusApplyResult => {
      const store = useAppStore.getState()
      if (!store.workspaceSessionReady) {
        return 'dropped'
      }
      const payload = normalizeAgentStatusPayload({
        state: data.state,
        prompt: data.prompt,
        agentType: data.agentType,
        toolName: data.toolName,
        toolInput: data.toolInput,
        lastAssistantMessage: data.lastAssistantMessage,
        interrupted: data.interrupted
      })
      if (!payload) {
        return 'dropped'
      }
      let {
        exists,
        title,
        identityTitle,
        repoConnectionId,
        repoConnectionResolved,
        owningWorktreeId
      } = resolvePaneKey(store, data.paneKey)
      if (!exists && data.worktreeId && hasRuntimeBackedWorktreeAttribution(data)) {
        // Why: orchestration worker hooks can carry main-side worktree
        // attribution before this renderer has a terminal tab for the pane.
        // Require runtime identity too; durable snapshots with only worktreeId
        // can be stale cached rows from closed/remounted panes.
        const fallbackOwnership = resolveWorktreeConnection(store, data.worktreeId)
        if (fallbackOwnership.worktreeExists) {
          owningWorktreeId = data.worktreeId
          repoConnectionId = fallbackOwnership.repoConnectionId
          repoConnectionResolved = fallbackOwnership.repoConnectionResolved
          exists = true
        }
      }
      if (!exists) {
        // Why: empty paneKeys are dropped in main before IPC fanout. Reaching
        // this branch means a non-empty paneKey escaped without a matching
        // renderer tab, so track the adoption/routing failure separately.
        // Skipped during snapshot replay because main's durable cache may
        // include entries whose tabs were closed before this session — that
        // reconciliation miss is not a regression signal.
        if (options?.replay !== true) {
          if (options?.retry !== true) {
            track('agent_hook_unattributed', { reason: 'unknown_tab_id' })
            // Why: live hook IPC can beat the renderer's tab/layout hydration.
            // Main already cached the event; retry locally so a transient
            // pane-key miss does not drop Droid/Codex completion state.
            enqueuePendingAgentStatus(data)
          }
          return 'pending'
        }
        return 'dropped'
      }
      if (options?.replay !== true && options?.retry !== true) {
        for (let index = pendingAgentStatusEvents.length - 1; index >= 0; index -= 1) {
          if (pendingAgentStatusEvents[index].data.paneKey === data.paneKey) {
            pendingAgentStatusEvents.splice(index, 1)
          }
        }
      }
      // Why: drop in-flight events from a connection that no longer owns
      // this pane. After an SSH disconnect (or tab destroy/recreate during
      // reconnect), notifications may still arrive stamped with the
      // connectionId of the dead connection. The renderer compares the
      // stamped connectionId against the live repo's connectionId for the
      // pane's worktree — see docs/design/agent-status-over-ssh.md §5.
      // The IPC contract declares connectionId as required (string | null),
      // so the undefined branch only fires under dev hot-reload skew where
      // the renderer bundle is newer than the preload bundle.
      // Why: startup snapshot replay can beat repo/worktree hydration for SSH
      // panes. If the pane is already present and the event's worktreeId
      // matches that tab's worktree, accept the status until repo ownership
      // becomes available; once ownership is resolved, keep the strict
      // connectionId check below.
      const canAcceptPendingRemoteOwnership =
        data.connectionId !== undefined &&
        data.connectionId !== null &&
        !repoConnectionResolved &&
        data.worktreeId !== undefined &&
        data.worktreeId === owningWorktreeId
      if (
        data.connectionId !== undefined &&
        data.connectionId !== repoConnectionId &&
        !canAcceptPendingRemoteOwnership
      ) {
        return 'dropped'
      }
      const resolvedPayload = resolveHookPayloadAgentType(payload, identityTitle ?? title)
      const statusPayload = data.orchestration
        ? { ...resolvedPayload, orchestration: data.orchestration }
        : resolvedPayload
      const existingStatus = store.agentStatusByPaneKey[data.paneKey]
      const identity = resolveAgentStatusIdentity({
        existing: existingStatus
          ? {
              agentType: existingStatus.agentType,
              state: existingStatus.state,
              updatedAt: existingStatus.updatedAt
            }
          : undefined,
        incoming: statusPayload.agentType,
        now: data.receivedAt
      })
      if (
        existingStatus &&
        shouldSuppressInheritedTerminalStatus({
          inheritedFromActivePane: identity.inheritedFromActivePane,
          incomingState: statusPayload.state
        })
      ) {
        // Why: renderer may receive an old/stale main-process child completion.
        // Keep the defensive store guard and completion notification path in sync.
        return 'dropped'
      }
      const terminalTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
      const statusWorktreeId = data.worktreeId ?? owningWorktreeId
      store.setAgentStatus(
        data.paneKey,
        statusPayload,
        terminalTitle,
        {
          updatedAt: data.receivedAt,
          stateStartedAt: data.stateStartedAt
        },
        {
          tabId: data.tabId,
          worktreeId: statusWorktreeId,
          terminalHandle: data.terminalHandle
        },
        data.providerSession ? { providerSession: data.providerSession } : undefined
      )
      applyResolvedAgentTerminalTitleToTab(store, data.paneKey, title, terminalTitle)
      if (options?.replay !== true && statusWorktreeId) {
        // Why: local Codex/Claude hooks arrive through this main-process IPC
        // path, not the PTY OSC fallback, so task-complete notifications must
        // observe accepted hook state here as well.
        const notificationPayload =
          typeof data.stateStartedAt === 'number'
            ? { ...resolvedPayload, stateStartedAt: data.stateStartedAt }
            : resolvedPayload
        observeAgentHookCompletionForNotification({
          paneKey: data.paneKey,
          worktreeId: statusWorktreeId,
          payload: notificationPayload
        })
      }
      return 'applied'
    }

    let snapshotRequestedForReadyWindow = false
    let snapshotRequestId = 0
    const requestAgentStatusSnapshotIfReady = (): void => {
      const store = useAppStore.getState()
      if (!store.workspaceSessionReady) {
        snapshotRequestedForReadyWindow = false
        return
      }
      if (snapshotRequestedForReadyWindow) {
        return
      }
      const getSnapshot = window.api.agentStatus.getSnapshot
      if (typeof getSnapshot !== 'function') {
        return
      }
      snapshotRequestedForReadyWindow = true
      const requestId = ++snapshotRequestId
      void getSnapshot()
        .then((entries) => {
          if (requestId !== snapshotRequestId) {
            return
          }
          const current = useAppStore.getState()
          if (!current.workspaceSessionReady) {
            return
          }
          for (const entry of entries) {
            applyAgentStatus(entry, { replay: true })
          }
          const getMigrationUnsupportedSnapshot =
            window.api.agentStatus.getMigrationUnsupportedSnapshot
          if (typeof getMigrationUnsupportedSnapshot !== 'function') {
            return
          }
          void getMigrationUnsupportedSnapshot().then((unsupportedEntries) => {
            const unsupportedStore = useAppStore.getState()
            if (!unsupportedStore.workspaceSessionReady) {
              return
            }
            for (const entry of unsupportedEntries) {
              if (entry.paneKey && resolvePaneKey(unsupportedStore, entry.paneKey).exists) {
                unsupportedStore.setMigrationUnsupportedPty(entry)
              }
            }
          })
        })
        .catch((err) => {
          // Why: keep snapshotRequestedForReadyWindow latched on failure. The
          // store subscriber below fires on every update (including high-rate
          // PTY ticks), so resetting the flag here would turn a persistent IPC
          // failure into an unbounded retry storm. One warning per ready
          // window is sufficient; the flag still clears when
          // workspaceSessionReady toggles off, so a fresh workspace re-ready
          // cycle will retry.
          console.warn('[agent-status] failed to load startup snapshot:', err)
        })
    }

    unsubs.push(
      window.api.agentStatus.onSet((data) => {
        applyAgentStatus(data)
      })
    )
    const unsubscribeAgentStatusClear = window.api.agentStatus.onClear?.((data) => {
      if (typeof data?.paneKey !== 'string') {
        return
      }
      const store = useAppStore.getState()
      if (store.agentStatusByPaneKey[data.paneKey]?.state === 'done') {
        return
      }
      store.removeAgentStatus(data.paneKey)
    })
    if (unsubscribeAgentStatusClear) {
      unsubs.push(unsubscribeAgentStatusClear)
    }
    const unsubscribeMigrationUnsupported = window.api.agentStatus.onMigrationUnsupported?.(
      (entry) => {
        const store = useAppStore.getState()
        if (!store.workspaceSessionReady) {
          return
        }
        if (entry.paneKey && resolvePaneKey(store, entry.paneKey).exists) {
          store.setMigrationUnsupportedPty(entry)
        }
      }
    )
    if (unsubscribeMigrationUnsupported) {
      unsubs.push(unsubscribeMigrationUnsupported)
    }
    const unsubscribeMigrationUnsupportedClear =
      window.api.agentStatus.onMigrationUnsupportedClear?.(({ ptyId }) => {
        useAppStore.getState().clearMigrationUnsupportedPty(ptyId)
      })
    if (unsubscribeMigrationUnsupportedClear) {
      unsubs.push(unsubscribeMigrationUnsupportedClear)
    }

    // Why: the main hook server is the durable source of truth. Pull a
    // snapshot only after workspace tabs are ready, so early startup pushes
    // can be safely ignored instead of buffered against partially hydrated
    // renderer state.
    requestAgentStatusSnapshotIfReady()
    unsubs.push(
      useAppStore.subscribe(() => {
        requestAgentStatusSnapshotIfReady()
        flushPendingAgentStatuses()
        syncAgentHookCompletionNotificationSettings()
      })
    )

    let mobileStateHydrated = isRuntimeEnvironmentActive()
    type PendingMobileStateEvent =
      | {
          kind: 'fit'
          event: {
            ptyId: string
            mode: 'mobile-fit' | 'desktop-fit'
            cols: number
            rows: number
          }
        }
      | {
          kind: 'driver'
          event: {
            ptyId: string
            driver: RuntimeTerminalDriverState
          }
        }
      | {
          kind: 'browser-driver'
          event: {
            browserPageId: string
            driver: RuntimeBrowserDriverState
          }
        }
    const pendingMobileStateEvents: PendingMobileStateEvent[] = []
    let mobileStateHydrationDisposed = false

    const applyPendingMobileStateEvents = (): void => {
      for (const pending of pendingMobileStateEvents) {
        if (pending.kind === 'fit') {
          const { ptyId, mode, cols, rows } = pending.event
          setFitOverride(ptyId, mode, cols, rows)
        } else if (pending.kind === 'driver') {
          setDriverForPty(pending.event.ptyId, pending.event.driver)
        } else {
          setDriverForBrowserPage(pending.event.browserPageId, pending.event.driver)
        }
      }
      pendingMobileStateEvents.length = 0
    }

    const enqueuePendingMobileStateEvent = (event: PendingMobileStateEvent): void => {
      pendingMobileStateEvents.push(event)
      while (pendingMobileStateEvents.length > MAX_PENDING_MOBILE_STATE_EVENTS) {
        pendingMobileStateEvents.shift()
      }
    }

    unsubs.push(
      window.api.runtime.onTerminalFitOverrideChanged((event) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        if (!mobileStateHydrated) {
          enqueuePendingMobileStateEvent({ kind: 'fit', event })
          return
        }
        setFitOverride(event.ptyId, event.mode, event.cols, event.rows)
      })
    )

    unsubs.push(
      // Why: presence-lock driver state mirror. Updates the renderer's
      // mobile-driver-state map so TerminalPane / pty-connection guards
      // know which PTYs are currently driven by mobile. See
      // docs/mobile-presence-lock.md.
      window.api.runtime.onTerminalDriverChanged((event) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        if (!mobileStateHydrated) {
          enqueuePendingMobileStateEvent({ kind: 'driver', event })
          return
        }
        setDriverForPty(event.ptyId, event.driver)
      })
    )

    unsubs.push(
      window.api.runtime.onBrowserDriverChanged((event) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        if (!mobileStateHydrated) {
          enqueuePendingMobileStateEvent({ kind: 'browser-driver', event })
          return
        }
        setDriverForBrowserPage(event.browserPageId, event.driver)
      })
    )

    // Why: hydrate mobile-owned terminal state on renderer reload. Subscribe
    // first and buffer live events during the snapshot round trip; otherwise an
    // older snapshot could overwrite a newer live lock and hide the overlay.
    if (!isRuntimeEnvironmentActive()) {
      void Promise.all([
        window.api.runtime.getTerminalFitOverrides(),
        window.api.runtime.getTerminalDrivers(),
        window.api.runtime.getBrowserDrivers()
      ])
        .then(([overrides, drivers, browserDrivers]) => {
          if (mobileStateHydrationDisposed) {
            return
          }
          hydrateOverrides(overrides)
          hydrateDrivers(drivers)
          hydrateBrowserDrivers(browserDrivers)
          mobileStateHydrated = true
          applyPendingMobileStateEvents()
        })
        .catch((error: unknown) => {
          if (mobileStateHydrationDisposed) {
            return
          }
          console.error('Failed to hydrate mobile terminal state:', error)
          mobileStateHydrated = true
          applyPendingMobileStateEvents()
        })
    }

    return () => {
      if (pendingAgentStatusRetryTimer !== null) {
        globalThis.clearTimeout(pendingAgentStatusRetryTimer)
      }
      pendingAgentStatusEvents.length = 0
      mobileStateHydrationDisposed = true
      pendingMobileStateEvents.length = 0
      unsubs.forEach((fn) => fn())
      resetAgentHookCompletionNotificationCoordinators()
    }
  }, [])
}

function hasRuntimeBackedWorktreeAttribution(data: AgentStatusIpcPayload): boolean {
  return (
    (typeof data.terminalHandle === 'string' && data.terminalHandle.length > 0) ||
    data.orchestration !== undefined
  )
}

function applyResolvedAgentTerminalTitleToTab(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string,
  previousTitle: string | undefined,
  nextTitle: string | undefined
): void {
  if (!nextTitle || nextTitle === previousTitle) {
    return
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return
  }
  const layout = store.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && layout.activeLeafId && layout.activeLeafId !== parsed.leafId) {
    return
  }
  // Why: hook completion can arrive while the pane transport is unmounted.
  // Keep the active terminal tab label in sync with the resolved state title.
  store.updateTabTitle(parsed.tabId, nextTitle)
}

/** Resolve a paneKey (tabId:leafId) to both a liveness check and the current
 *  title, the pane's worktree, and the connectionId of the repo that owns it.
 *  Walks tabsByWorktree to locate the tab, then resolves the owning worktree
 *  and repo via cached selector maps. Used for agent type inference when the
 *  CLI payload omits agentType, plus to drop status updates targeted at panes
 *  whose tabs have already been torn down or whose owning connection is no
 *  longer live (see docs/design/agent-status-over-ssh.md §5).
 *  Why combined: callers need all routing pieces per hook event, and hook
 *  events can fire many times per second during a tool-use run. Bundling
 *  liveness + title + connectionId into one helper keeps the per-event work
 *  in one place and avoids re-deriving the owning repo at the call site. */
function resolvePaneKey(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string
): {
  exists: boolean
  title: string | undefined
  identityTitle: string | undefined
  repoConnectionId: string | null
  repoConnectionResolved: boolean
  owningWorktreeId: string | undefined
} {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId: null,
      repoConnectionResolved: false,
      owningWorktreeId: undefined
    }
  }
  const { tabId, leafId } = parsed
  const layout = store.terminalLayoutsByTabId?.[tabId]
  let exists = false
  let tabTitle: string | undefined
  let unifiedTabLabel: string | undefined
  let owningWorktreeId: string | undefined
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id === tabId) {
        exists = true
        tabTitle = tab.title
        owningWorktreeId = worktreeId
        const visibleTab = (store.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
        )
        const rawVisibleLabel = visibleTab?.label?.trim()
        unifiedTabLabel =
          rawVisibleLabel && rawVisibleLabel.length > 0 ? rawVisibleLabel : undefined
        break
      }
    }
    if (exists) {
      break
    }
  }
  // Why: ownership lookup is `tab → worktree → repo → repo.connectionId`.
  // Keep "resolved to a local repo" distinct from "not hydrated yet" so the
  // caller can preserve strict filtering after hydration while accepting SSH
  // snapshots that arrive during the startup ownership gap.
  let repoConnectionId: string | null = null
  let repoConnectionResolved = false
  if (owningWorktreeId !== undefined) {
    const worktree = getWorktreeMapFromState(store).get(owningWorktreeId)
    if (worktree) {
      const repo = getRepoMapFromState(store).get(worktree.repoId)
      repoConnectionResolved = repo !== undefined
      repoConnectionId = repo?.connectionId ?? null
    }
  }
  if (!exists) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId
    }
  }
  // Why: inactive worktree switches can leave the tab's layout at the empty
  // snapshot while the tab and PTY are still live. Treat that like missing
  // layout metadata; a non-empty layout that lacks the leaf still means closed.
  const leafExists = layout?.root ? collectLeafIdsInOrder(layout.root).includes(leafId) : true
  if (!leafExists) {
    return {
      exists: false,
      title: undefined,
      identityTitle: undefined,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId
    }
  }
  // Why: inactive worktrees can have a durable tab and live PTY while their
  // terminal layout is temporarily unmounted. Hook state must still land there.
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  // Why: treat an empty-string paneTitle as "no title" so the tab-level
  // fallback still fires. `paneTitle ?? tabTitle` alone would short-circuit on
  // '' and also erase any previously-cached terminalTitle in the store
  // (`terminalTitle ?? existing?.terminalTitle` resolves to '').
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists,
    title: paneTitle ?? tabTitle,
    // Why: some agents (OpenClaude in practice) keep the low-level terminal
    // title generic while the unified tab label carries the launched agent
    // identity. Use only the non-custom label as evidence for hook attribution.
    identityTitle: paneTitle ?? unifiedTabLabel ?? tabTitle,
    repoConnectionId,
    repoConnectionResolved,
    owningWorktreeId
  }
}

function resolveWorktreeConnection(
  store: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): {
  worktreeExists: boolean
  repoConnectionId: string | null
  repoConnectionResolved: boolean
} {
  const worktree = getWorktreeMapFromState(store).get(worktreeId)
  if (!worktree) {
    return { worktreeExists: false, repoConnectionId: null, repoConnectionResolved: false }
  }
  const repo = getRepoMapFromState(store).get(worktree.repoId)
  return {
    worktreeExists: true,
    repoConnectionId: repo?.connectionId ?? null,
    repoConnectionResolved: repo !== undefined
  }
}

function resolveHookPayloadAgentType(
  payload: ParsedAgentStatusPayload,
  terminalTitle: string | undefined
): ParsedAgentStatusPayload {
  if (
    payload.agentType !== 'claude' ||
    !terminalTitle ||
    !titleHasAgentName(terminalTitle, 'openclaude')
  ) {
    return payload
  }
  // Why: OpenClaude emits Claude-compatible hooks, so title identity is the
  // renderer's last chance to keep OpenClaude out of Claude-only status paths.
  return { ...payload, agentType: 'openclaude' }
}
