/* oxlint-disable max-lines -- Why: this App-level IPC bridge intentionally keeps the renderer's main-process event contract in one place so shortcut, runtime, updater, and agent-status wiring do not drift across files. */
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../store'
import { shouldRetryPaneSpawnOnSshReconnect } from './ssh-reconnect-pane-retry'
import { applyWorktreeHeadIdentities } from './worktree-head-identity-apply'
import { getWorktreeMapFromState, getRepoMapFromState } from '@/store/selectors'
import { applyUIZoom } from '@/lib/ui-zoom'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'
import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'
import { createBackgroundSleepingAgentWakeDispatcher } from '@/lib/wake-sleeping-agents-in-background'
import { OPEN_WORKSPACE_BOARD_EVENT } from '@/components/sidebar/useWorkspaceBoardPanel'
import { SPLIT_TERMINAL_PANE_EVENT, CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { planMobileTerminalTabMount } from '@/lib/mobile-terminal-tab-mount'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
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
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'
import type {
  RuntimeBrowserDriverState,
  RuntimeTerminalPresentation,
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
  type AgentStatusClearIpcPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../../shared/agent-status-types'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../shared/agent-status-identity'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
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
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '@/components/browser-pane/browser-automation-visibility'
import { attachMobileMarkdownBridge } from '@/runtime/mobile-markdown-bridge'
import { closeMobileSessionTabInStore } from '@/runtime/mobile-session-tab-close'
import { createWorktreeChangeRefreshQueue } from './worktree-change-refresh-queue'
import { subscribeRuntimeClientEvents } from '@/runtime/runtime-client-events'
import {
  applyRuntimeEnvironmentSshStateChanged,
  hydrateRuntimeEnvironmentSshState
} from '@/runtime/runtime-environment-ssh-state'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { createRuntimeProjectRefreshScheduler } from './runtime-project-refresh-scheduler'
import { createRuntimeClientEventsSync } from './runtime-client-events-sync'
import { detectLanguage } from '@/lib/language-detect'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { track } from '@/lib/telemetry'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
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
  syncAgentHookCompletionNotificationsForStoreUpdate
} from './agent-hook-completion-notifications'
import { shouldSuppressCodexAutoApprovalStatus } from '@/components/terminal-pane/codex-auto-approval-notification-suppression'
import { showTerminalShortcutCaptureNotification } from '@/lib/terminal-shortcut-capture-notification'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import { titleHasAgentName } from '../../../shared/agent-detection'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import { translate } from '@/i18n/i18n'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'

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
const RUNTIME_PROJECT_REFRESH_CONCURRENCY = 5
const browserAutomationBootstrapLeaseByPageId = new Map<string, { token: string; timer: number }>()

function resolveTerminalPresentation(data: {
  presentation?: RuntimeTerminalPresentation
  activate?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (data.presentation) {
    return data.presentation
  }
  if (data.activate === true) {
    return 'focused'
  }
  return undefined
}

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
  requestBackgroundTerminalWorktreeMount({ worktreeId: targetWorktreeId })
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
// Why: mobile driver hydration is async; cap replay so a stuck IPC snapshot can't retain an unbounded startup buffer.
const MAX_PENDING_MOBILE_STATE_EVENTS = 300
// Why: a rename's event burst lags the on-disk move; shield both ids from the deletion diff for a grace window.
const WORKTREE_RENAME_PURGE_GRACE_MS = 20_000
const recentlyRenamedWorktreeIdExpiry = new Map<string, number>()
let remoteWorkspaceSnapshotApplyDepth = 0
let remoteWorkspaceSnapshotWriteSuppressUntil = 0
const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1000

function isAgentStatusForRecentlyClosedTab(
  store: Pick<AppState, 'recentlyClosedAgentStatusTabIds' | 'recentlyRetiredAgentStatusPaneKeys'>,
  paneKey: string
): boolean {
  const ownerPaneKey = resolveAgentPaneAuthorityKey(paneKey)
  if (store.recentlyRetiredAgentStatusPaneKeys?.[ownerPaneKey] === true) {
    return true
  }
  const tabId = parsePaneKey(ownerPaneKey)?.tabId
  if (!tabId) {
    return false
  }
  return store.recentlyClosedAgentStatusTabIds[tabId] === true
}

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

function focusTerminalInitiatedTab(tabId: string, leafId?: string | null): void {
  if (!focusRuntimeTerminalSurface(tabId, leafId)) {
    focusTerminalTabSurface(tabId, leafId)
  }
}

function activateTerminalInitiatedWorktree(store: AppState, worktreeId: string): void {
  store.setActiveView('terminal')
  store.setActiveWorktree(worktreeId)
  // Why: CLI/runtime terminal focus is user-visible navigation, so feed both Cmd+J recency and the back/forward stack.
  store.markWorktreeVisited(worktreeId)
  if (!store.isNavigatingHistory) {
    store.recordWorktreeVisit(worktreeId)
  }
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
    // Why: reattach updates pty ids/titles after hydration; they came from the snapshot, don't echo back as a new revision.
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
    // Why: read the relay before publishing local tabs, or a reconnect can overwrite a newer snapshot with stale local state.
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
    // Why: Cmd+N from a Linear issue mirrors its Start-workspace action, else the agent launches without source context.
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

function getReachableRuntimeEnvironmentIds(): string[] {
  const state = useAppStore.getState()
  const ids: string[] = []
  for (const [environmentId, status] of state.runtimeStatusByEnvironmentId ?? []) {
    if (status?.status) {
      ids.push(environmentId)
    }
  }
  return ids
}

export function buildRuntimeClientEventEnvironmentKey(environmentIds: string[]): string {
  return [...new Set(environmentIds)].sort().join('\u0000')
}

/** Ids in `next` not in `previous` — environments that just became connected (exported to unit-test on-connect discovery). */
export function getNewlyConnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  const known = new Set(previous)
  return [...new Set(next)].filter((environmentId) => !known.has(environmentId))
}

/** Ids in `previous` not in `next` — environments whose transport was just observed down. */
export function getNewlyDisconnectedRuntimeEnvironmentIds(
  previous: readonly string[],
  next: readonly string[]
): string[] {
  return getNewlyConnectedRuntimeEnvironmentIds(next, previous)
}

export function getRuntimeProjectRefreshEnvironmentIds(args: {
  previousDesired: readonly string[]
  nextDesired: readonly string[]
  previousReachable: readonly string[]
  nextReachable: readonly string[]
}): string[] {
  return [
    ...new Set([
      ...getNewlyConnectedRuntimeEnvironmentIds(args.previousDesired, args.nextDesired),
      ...getNewlyConnectedRuntimeEnvironmentIds(args.previousReachable, args.nextReachable)
    ])
  ]
}

async function refreshRuntimeProjectWorktrees(repos: readonly { id: string }[]): Promise<void> {
  let nextIndex = 0
  const failures: { repoId: string; error: unknown }[] = []
  const workerCount = Math.min(RUNTIME_PROJECT_REFRESH_CONCURRENCY, repos.length)

  // Why: one coalesced repo event can represent many repos; bound the probes so idle refresh never floods the renderer.
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < repos.length) {
        const index = nextIndex
        nextIndex += 1
        const repoId = repos[index].id
        try {
          await useAppStore.getState().fetchWorktrees(repoId)
        } catch (error) {
          failures.push({ repoId, error })
        }
      }
    })
  )
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Failed to refresh ${failures.length} runtime project worktree(s): ${failures
        .map((failure) => failure.repoId)
        .join(', ')}`
    )
  }
}

function getWorktreeRuntimeEnvironmentId(worktreeId: string | null | undefined): string | null {
  return getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
}

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []
    const backgroundSleepingAgentWakeDispatcher = createBackgroundSleepingAgentWakeDispatcher()
    unsubs.push(backgroundSleepingAgentWakeDispatcher.dispose)
    type PendingAgentStatusEvent = {
      data: AgentStatusIpcPayload
      firstSeenAt: number
    }
    type AgentStatusApplyResult = 'applied' | 'pending' | 'dropped'
    const pendingAgentStatusEvents: PendingAgentStatusEvent[] = []
    const transientClearWatermarkByConnectionId = new Map<string, number>()
    let agentStatusEffectDisposed = false
    let pendingAgentStatusRetryTimer: ReturnType<typeof setTimeout> | null = null
    // Why: setAgentStatus notifies synchronously and re-enters this flush mid-drain; guard re-entrancy (crash 9fc89529).
    let isFlushingAgentStatuses = false

    unsubs.push(attachMobileMarkdownBridge())

    const handleWorktreesChanged = async (
      repoId: string,
      renamed?: { oldWorktreeId: string; newWorktreeId: string }
    ): Promise<void> => {
      // Why: capture active-ness before migration moves the pointer; re-key maps before the diff so a rename isn't a deletion.
      const renamedWasActive =
        renamed != null && useAppStore.getState().activeWorktreeId === renamed.oldWorktreeId
      if (renamed) {
        // Shield both ids from the deletion diff across the rename's event burst — the worktree list lags the on-disk move.
        const expiry = Date.now() + WORKTREE_RENAME_PURGE_GRACE_MS
        recentlyRenamedWorktreeIdExpiry.set(renamed.oldWorktreeId, expiry)
        recentlyRenamedWorktreeIdExpiry.set(renamed.newWorktreeId, expiry)
        useAppStore.getState().migrateWorktreeIdentity(renamed.oldWorktreeId, renamed.newWorktreeId)
      }
      // Why: diff before/after fetch to catch out-of-band deletions and purge worktree state, else zombie ptyId entries leak (design §2c, §4.4).
      const state = useAppStore.getState()
      const before =
        getAuthoritativeDetectedWorktreeIds(state, repoId) ??
        getVisibleWorktreeIdsForRepo(state, repoId)
      await state.fetchWorktrees(repoId)
      await useAppStore.getState().fetchWorktreeLineage()
      // Why: an id change unmounts the active pane; re-activate so the tab reconciles, else it vanishes until re-select.
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
        // A recently renamed worktree's old/new id isn't a deletion — its state moved to the new id; the list just lags.
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
    const worktreeChangeRefreshQueue = createWorktreeChangeRefreshQueue(handleWorktreesChanged)
    unsubs.push(worktreeChangeRefreshQueue.dispose)

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
        // Why: local CLI worktree events carry local ids; runtime activation comes via the remote stream, allowed separately.
        return
      }
      const existedBeforeFetch = Boolean(useAppStore.getState().getKnownWorktreeById(worktreeId))
      // Why: fetch first so activation can resolve the CLI-created worktree; it arrived from main, not yet in renderer state.
      await useAppStore.getState().fetchWorktrees(repoId)
      const existsAfterFetch = Boolean(useAppStore.getState().getKnownWorktreeById(worktreeId))
      // Why: use the canonical activation path so the CLI switch records a back/forward visit, or the nav buttons ignore it.
      activateAndRevealWorktree(worktreeId, {
        ...(setup ? { setup } : {}),
        ...(startup ? { startup } : {}),
        ...(defaultTabs ? { defaultTabs } : {}),
        ...(!existedBeforeFetch && existsAfterFetch ? { sidebarRevealBehavior: 'auto' } : {}),
        // Why: this activation came from the host runtime stream; echoing it back can create a selection loop.
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

    const runtimeProjectRefreshScheduler = createRuntimeProjectRefreshScheduler({
      refresh: async (environmentId) => {
        if (!isPairedWebClientWindow()) {
          // Why: refresh the env's SSH bucket on (re)connect so a pre-drop snapshot can't keep a reconnect overlay stale.
          void hydrateRuntimeEnvironmentSshState(environmentId, { force: true }).catch(() => {})
        }
        const repos = await useAppStore.getState().fetchRuntimeEnvironmentRepos(environmentId)
        await refreshRuntimeProjectWorktrees(repos)
        await useAppStore.getState().fetchWorktreeLineage()
      },
      onError: (error) => {
        console.error('Failed to refresh runtime projects:', error)
      }
    })

    // Assigned later (by the ssh.onStateChanged wiring); safe because subscriptions attach asynchronously.
    let handleSshStateChangedEvent: ((data: { targetId: string; state: unknown }) => void) | null =
      null

    const handleRuntimeClientEvent = (environmentId: string, event: RuntimeClientEvent): void => {
      if (event.type === 'reposChanged') {
        runtimeProjectRefreshScheduler.request(environmentId)
        return
      }
      if (event.type === 'sshStateChanged') {
        // Why: a paired web client mirrors host SSH state globally (STA-1468); desktop routes it to the env's own bucket.
        if (isPairedWebClientWindow()) {
          handleSshStateChangedEvent?.({ targetId: event.targetId, state: event.state })
        } else {
          applyRuntimeEnvironmentSshStateChanged(environmentId, event.targetId, event.state)
        }
        return
      }
      if (event.type === 'worktreesChanged') {
        void ensureRuntimeEventRepoKnown(environmentId, event.repoId).then(() =>
          worktreeChangeRefreshQueue.enqueue({ repoId: event.repoId })
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

    const runtimeClientEventsSync = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: getRuntimeClientEventEnvironmentIds,
      subscribe: (environmentId, onEvent, onError) =>
        subscribeRuntimeClientEvents(environmentId, onEvent, onError, () => {
          // Why: events during a transport gap are lost; a quick reconnect won't flip unreachable, so refetch (#7970).
          runtimeProjectRefreshScheduler.request(environmentId)
          if (isPairedWebClientWindow()) {
            return
          }
          // Why: sshStateChanged events during the transport gap are lost, so downgrade the possibly-stale bucket, then refetch.
          useAppStore.getState().markEnvironmentSshStateStale(environmentId)
          void hydrateRuntimeEnvironmentSshState(environmentId, { force: true }).catch(() => {})
        }),
      onEvent: handleRuntimeClientEvent
    })

    runtimeClientEventsSync.sync()
    // Why: no on-connect repo fetch (PR #2); seed discovery for connected runtimes or remote projects hide until Add-Project.
    let runtimeClientEventEnvironmentIds = getRuntimeClientEventEnvironmentIds()
    for (const environmentId of runtimeClientEventEnvironmentIds) {
      runtimeProjectRefreshScheduler.request(environmentId)
    }
    let runtimeClientEventEnvironmentKey = buildRuntimeClientEventEnvironmentKey(
      runtimeClientEventEnvironmentIds
    )
    let reachableRuntimeEnvironmentIds = getReachableRuntimeEnvironmentIds()
    let reachableRuntimeEnvironmentKey = buildRuntimeClientEventEnvironmentKey(
      reachableRuntimeEnvironmentIds
    )
    unsubs.push(
      useAppStore.subscribe(() => {
        const nextEnvironmentIds = getRuntimeClientEventEnvironmentIds()
        const nextKey = buildRuntimeClientEventEnvironmentKey(nextEnvironmentIds)
        const nextReachableEnvironmentIds = getReachableRuntimeEnvironmentIds()
        const nextReachableKey = buildRuntimeClientEventEnvironmentKey(nextReachableEnvironmentIds)
        if (
          nextKey === runtimeClientEventEnvironmentKey &&
          nextReachableKey === reachableRuntimeEnvironmentKey
        ) {
          return
        }
        for (const environmentId of getRuntimeProjectRefreshEnvironmentIds({
          previousDesired: runtimeClientEventEnvironmentIds,
          nextDesired: nextEnvironmentIds,
          previousReachable: reachableRuntimeEnvironmentIds,
          nextReachable: nextReachableEnvironmentIds
        })) {
          runtimeProjectRefreshScheduler.request(environmentId)
        }
        for (const environmentId of getNewlyDisconnectedRuntimeEnvironmentIds(
          reachableRuntimeEnvironmentIds,
          nextReachableEnvironmentIds
        )) {
          // No-op when the environment has no SSH bucket (e.g. web client).
          useAppStore.getState().markEnvironmentSshStateStale(environmentId)
        }
        runtimeClientEventEnvironmentIds = nextEnvironmentIds
        runtimeClientEventEnvironmentKey = nextKey
        reachableRuntimeEnvironmentIds = nextReachableEnvironmentIds
        reachableRuntimeEnvironmentKey = nextReachableKey
        runtimeClientEventsSync.sync()
      })
    )
    unsubs.push(runtimeClientEventsSync.stop)
    unsubs.push(runtimeProjectRefreshScheduler.stop)

    unsubs.push(
      window.api.repos.onChanged(() => {
        const state = useAppStore.getState()
        if (isRuntimeEnvironmentActive()) {
          // Why: the all-host sidebar shows local repos even under a runtime; refresh the local slice, keep runtime slices.
          void (async () => {
            await state.fetchReposForAllHosts()
            await state.fetchProjectGroupsForAllHosts()
            await state.fetchFolderWorkspacesForAllHosts()
          })()
          return
        }
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
            // Why: local worktree events carry local repo ids; fetching the runtime with them can purge or overwrite server state.
            return
          }
          // A folder rename changes the worktree id; handleWorktreesChanged re-keys state and shields it from the deletion diff.
          worktreeChangeRefreshQueue.enqueue(data)
        }
      )
    )

    if (window.api.worktrees.onHeadIdentitiesChanged) {
      unsubs.push(
        window.api.worktrees.onHeadIdentitiesChanged((data) => {
          if (isRuntimeEnvironmentActive()) {
            // Why: local worktree events carry local repo ids (see onChanged).
            return
          }
          const state = useAppStore.getState()
          applyWorktreeHeadIdentities(data, {
            getWorktreesForRepo: (repoId) => state.worktreesByRepo[repoId],
            updateWorktreeGitIdentity: state.updateWorktreeGitIdentity
          })
        })
      )
    }

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

    // Why: route main's two-phase creation progress to each pending entry by correlation id (?. guards stale preload).
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

    // Why: a tray "Settings…" click can fire before this attaches; consume any queued intent (?. guards stale preload).
    void window.api.ui
      .consumePendingOpenSettings?.()
      .then((open) => {
        if (open) {
          useAppStore.getState().openSettingsPage()
        }
      })
      .catch(() => {})

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

    // Why: View > Appearance toggles settings in main and broadcasts; merge into the store for an immediate re-render.
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

    // Why: UI view-state is shared with mobile via ui.set; re-hydrate so mobile changes reflect live in the desktop sidebar.
    unsubs.push(
      window.api.ui.onStateChanged((ui) => {
        useAppStore.getState().hydratePersistedUI(ui, 'sync')
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
      window.api.ui.onToggleQuickCommandsMenu(() => {
        window.dispatchEvent(new CustomEvent(TOGGLE_QUICK_COMMANDS_MENU_EVENT))
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
        // Why: mirror button visibility — worktree history nav is only meaningful in the terminal view, so no-op elsewhere.
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
          cwd,
          env,
          launchConfig,
          launchToken,
          launchAgent,
          viewMode,
          title,
          ptyId,
          activate,
          presentation,
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
            const terminalPresentation = resolveTerminalPresentation({ presentation, activate })
            const shouldActivate = terminalPresentation === 'focused'
            const shouldSurfaceOwner = terminalPresentation !== 'background'
            if (shouldActivate) {
              activateTerminalInitiatedWorktree(store, worktreeId)
            }
            const worktreeTabs = store.tabsByWorktree[worktreeId] ?? []
            const existingTab = ptyId
              ? worktreeTabs.find(
                  (candidate) =>
                    candidate.ptyId === ptyId ||
                    (store.ptyIdsByTabId[candidate.id] ?? []).includes(ptyId)
                )
              : undefined
            const isSplitReveal = Boolean(ptyId && tabId && leafId && splitFromLeafId)
            const splitTargetTab = isSplitReveal
              ? worktreeTabs.find((candidate) => candidate.id === tabId)
              : undefined
            if (isSplitReveal && !splitTargetTab) {
              throw new Error(`Terminal tab ${tabId} not found`)
            }
            const hintedPendingTab =
              ptyId && tabId && !isSplitReveal
                ? worktreeTabs.find((candidate) => {
                    if (candidate.id !== tabId) {
                      return false
                    }
                    const candidatePtyIds = store.ptyIdsByTabId[candidate.id] ?? []
                    return candidate.ptyId == null && candidatePtyIds.length === 0
                  })
                : undefined
            // Why: runtime fallback reveals a PTY for a renderer-created pending tab; adopt only when the hinted tab has no PTY yet.
            const reusedTab = existingTab ?? splitTargetTab ?? hintedPendingTab
            const tab =
              reusedTab ??
              (ptyId
                ? store.createTab(worktreeId, undefined, undefined, {
                    initialPtyId: ptyId,
                    activate: shouldActivate,
                    ...(launchAgent
                      ? {
                          launchAgent,
                          // Why: a paired client resolved explicit mode before PTY materialization; only omitted mode uses host defaults.
                          ...(viewMode
                            ? { viewMode }
                            : initialAgentTabViewModeProps(store.settings, {
                                agent: launchAgent,
                                nativeChatTranscriptIsLocalReadable:
                                  isNativeChatTranscriptLocalReadable(
                                    getConnectionIdFromState(store, worktreeId)
                                  )
                              }))
                        }
                      : {}),
                    ...(cwd ? { startupCwd: cwd } : {}),
                    // Why: CLI-spawned PTYs bake the pane key into env; adopt the same tab id so hook-event attribution keeps working.
                    ...(tabId !== undefined ? { id: tabId } : {})
                  })
                : store.createTab(
                    worktreeId,
                    undefined,
                    undefined,
                    shouldActivate
                      ? cwd
                        ? { startupCwd: cwd }
                        : undefined
                      : {
                          activate: false,
                          recordInteraction: false,
                          ...(cwd ? { startupCwd: cwd } : {})
                        }
                  ))
            // Why: a reused tab whose id differs from the hint breaks the PTY's baked-in paneKey attribution; warn during dev.
            if (tabId !== undefined && tab.id !== tabId) {
              console.warn(
                `[onCreateTerminal] tabId hint ${tabId} ignored for ptyId ${ptyId}; existing tab ${tab.id} adopted instead (hook attribution will degrade for this terminal)`
              )
            }
            if (shouldActivate) {
              store.setActiveTabType('terminal')
              store.setActiveTab(tab.id)
            }
            if (shouldSurfaceOwner) {
              store.revealWorktreeInSidebar(worktreeId)
              focusTerminalInitiatedTab(tab.id, leafId)
            }
            // Why: only stamp the runtime title on fresh tabs; reused tabs may have a user customTitle it would overwrite on focus.
            if (title && !reusedTab) {
              store.setTabCustomTitle(tab.id, title, { recordInteraction: false })
            }
            if (leafId && ptyId) {
              const launchPaneKey = tryMakePaneKey(tab.id, leafId)
              if (launchConfig) {
                if (launchPaneKey) {
                  store.registerAgentLaunchConfig(launchPaneKey, launchConfig, {
                    ...(launchAgent ? { agentType: launchAgent } : {}),
                    ...(launchToken ? { launchToken } : {}),
                    tabId: tab.id,
                    leafId
                  })
                }
              } else if (!splitFromLeafId && launchPaneKey) {
                store.clearAgentLaunchConfig(launchPaneKey)
              }
              if (splitFromLeafId) {
                // Why: runtime split PTYs already carry the parent tab's paneKey, so reuse the tab instead of minting a collision tab.
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
                // Why: CLI/runtime PTYs emit hook events before the tab mounts, so the leaf must exist in layout for paneKey validation.
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
              store.queueTabStartupCommand(tab.id, {
                command,
                ...(env ? { env } : {}),
                ...(launchConfig ? { launchConfig } : {}),
                ...(launchToken ? { launchToken } : {}),
                ...(launchAgent ? { launchAgent } : {})
              })
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

    // Why: background-mount a mobile-subscribed tab's PTY without navigating the desktop (STA-1840).
    unsubs.push(
      window.api.ui.onRequestTerminalTabMount(({ worktreeId, tabId, ptyId }) => {
        if (!worktreeId) {
          return
        }
        // Why: synthetic pty handles need persisted-tab resolution; a miss must not mount every saved tab in a hidden worktree.
        const mount = planMobileTerminalTabMount(
          useAppStore.getState(),
          {
            worktreeId,
            ...(tabId ? { tabId } : {}),
            ...(ptyId ? { ptyId } : {})
          },
          {
            isTabMounted: hasRegisteredRuntimeTerminalTab
          }
        )
        if (mount) {
          requestBackgroundTerminalWorktreeMount(mount)
        }
      })
    )

    // Why: CLI-driven terminal creation waits for the tabId reply so it can hand the caller a usable handle immediately.
    unsubs.push(
      window.api.ui.onRequestTerminalCreate((data) => {
        try {
          // Why: runtime-session requests are host-owned tabs materialized by this renderer, not ordinary local creates.
          if (isRuntimeEnvironmentActive() && data.source !== 'runtime-session') {
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
          const terminalPresentation = resolveTerminalPresentation(data)
          const shouldActivate = terminalPresentation === 'focused'
          const shouldSurfaceOwner = terminalPresentation !== 'background'
          if (shouldActivate) {
            activateTerminalInitiatedWorktree(store, worktreeId)
          }
          // Why: the paired launch client already resolved the mode, so its choice wins over the host renderer's local default.
          const tabOptions = data.launchAgent
            ? {
                ...(shouldActivate ? {} : { activate: false, recordInteraction: false }),
                launchAgent: data.launchAgent,
                ...(data.viewMode
                  ? { viewMode: data.viewMode }
                  : initialAgentTabViewModeProps(store.settings, {
                      agent: data.launchAgent,
                      nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
                        getConnectionIdFromState(store, worktreeId)
                      )
                    })),
                ...(data.cwd ? { startupCwd: data.cwd } : {})
              }
            : shouldActivate
              ? data.cwd
                ? { startupCwd: data.cwd }
                : undefined
              : {
                  activate: false,
                  recordInteraction: false,
                  ...(data.cwd ? { startupCwd: data.cwd } : {})
                }
          const tab = store.createTab(worktreeId, data.targetGroupId, undefined, tabOptions)
          if (!shouldActivate) {
            // Why: renderer-backed Codex startup must mount its new TerminalPane without switching UI or connecting every saved tab.
            requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tab.id] })
          }
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
          }
          if (shouldSurfaceOwner) {
            store.revealWorktreeInSidebar(worktreeId)
            focusTerminalInitiatedTab(tab.id)
          }
          if (data.title) {
            store.setTabCustomTitle(tab.id, data.title, { recordInteraction: false })
          }
          if (data.command) {
            store.queueTabStartupCommand(tab.id, {
              command: data.command,
              ...(data.env ? { env: data.env } : {}),
              ...(data.launchConfig ? { launchConfig: data.launchConfig } : {}),
              ...(data.launchToken ? { launchToken: data.launchToken } : {}),
              ...(data.launchAgent ? { launchAgent: data.launchAgent } : {}),
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
          activateTerminalInitiatedWorktree(store, worktreeId)
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
          focusTerminalInitiatedTab(tabId, leafId)
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
            // Why: older/mobile fallback snapshots identify browser tabs by workspace id when no unified tab wrapper exists.
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
          // Why: browser tabs need their own active-page state, not the editor file activation path.
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
          onClose: () => {
            const currentStore = useAppStore.getState()
            closeMobileSessionTabInStore(currentStore, worktreeId, tabId)
          }
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
          // Why: renderer owns tab creation so grouped order and markdown bridges share the desktop File Explorer's store path.
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
          // Why: mobile renders diffs from metadata; the editor-local Changes shortcut would send plain markdown back to mobile.
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
          // Why: route pane closes via the lifecycle hook for sibling promotion (falls through to closeTab on the last pane).
          const detail: CloseTerminalPaneDetail = { tabId, paneRuntimeId }
          window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
        } else {
          closeTerminalTab(tabId)
        }
      })
    )

    // Why: during an in-place renderer reload an older preload can linger; keep this listener additive at that seam.
    if (window.api.ui.onTerminalTabCloseRequest) {
      unsubs.push(
        window.api.ui.onTerminalTabCloseRequest(({ requestId, tabId }) => {
          let responded = false
          const respond = (error?: string): void => {
            if (responded) {
              return
            }
            responded = true
            window.api.ui.respondTerminalTabClose({ requestId, ...(error ? { error } : {}) })
          }
          closeTerminalTab(tabId, {
            rejectPinned: true,
            onCancel: () => respond('terminal_tab_pinned'),
            onClosed: () => {
              void (async () => {
                const state = useAppStore.getState()
                await persistWorkspaceSessionByHost(
                  window.api.session,
                  buildWorkspaceSessionPayload(state),
                  state
                )
                respond()
              })().catch((error: unknown) => {
                respond(error instanceof Error ? error.message : 'terminal_tab_close_failed')
              })
            }
          })
        })
      )
    }

    unsubs.push(
      window.api.ui.onSleepWorktree(({ worktreeId }) => {
        void runSleepWorktree(worktreeId)
      })
    )

    unsubs.push(
      window.api.ui.onResumeSleepingAgents(({ worktreeId }) => {
        // Why: a phone opened this worktree; wake its slept agents without changing the desktop's worktree/tab/view.
        backgroundSleepingAgentWakeDispatcher.request(worktreeId)
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

    const unsubscribeCertificateFailure = window.api.browser.onCertificateFailureChanged?.(
      ({ browserPageId, failure }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        useAppStore.getState().setBrowserPageCertificateFailure(browserPageId, failure)
      }
    )
    if (unsubscribeCertificateFailure) {
      unsubs.push(unsubscribeCertificateFailure)
    }

    // Why: agent-browser navigates via CDP so did-navigate never fires; this IPC pushes live URL/title to the stale store.
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

    // Why: webviews start their guest only when shown; sent pre-automation so hidden tabs mount without moving the active pane.
    unsubs.push(
      window.api.browser.onActivateView(({ worktreeId, browserPageId }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        acquireBrowserAutomationBootstrapLease(worktreeId, browserPageId)
      })
    )

    // Why: `orca tab switch --focus` must NOT call setActiveWorktree — a global focus from one agent's parallel-worktree switch would steal the user's view.
    // focusBrowserTabInWorktree updates per-worktree state in place; globals flip only when the user is already on the targeted worktree.
    unsubs.push(
      window.api.browser.onPaneFocus(({ worktreeId, browserPageId }) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        const store = useAppStore.getState()
        // Why: worktreeId is null if the tab closed mid-switch; the activeWorktreeId fallback makes the focus call a safe no-op for a stale page id.
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
        // Why: only the renderer owns Orca's tab model, so main delegates link-open here.
        store.createBrowserTab(sourcePage.worktreeId, url, { title: url })
      })
    )

    // Why: embedded browser guests capture keyboard focus and bypass window-level keydown, so shortcuts are forwarded via IPC.
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
              // Why: paired web tabs are host-owned; on RPC failure leave local state so the next host snapshot stays authoritative.
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

    // Why: emulator IPC is additive; guard so older clients or partial preload mocks don't crash the hook when it's absent.
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
          // Why: manual launches pre-attach so the ready pane opens in the right split, not as a hidden tab in this group.
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

    // Why: reply with the page ID so main can await registerGuest before returning to the CLI.
    unsubs.push(
      window.api.ui.onRequestTabCreate((data) => {
        try {
          if (isRuntimeEnvironmentActive()) {
            // Why: browser automation targets client-local Electron webviews that runtime agents can't see or control.
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
          // Why: CLI-created tabs should land in the active browser tab's group, not the terminal's UI-active group.
          const activeBrowserTabId = store.activeBrowserTabIdByWorktree[worktreeId]
          const activeBrowserUnifiedTab = activeBrowserTabId
            ? (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
                (t) => t.contentType === 'browser' && t.entityId === activeBrowserTabId
              )
            : undefined

          // Why: a user-initiated open (data.activate, e.g. mobile tapping an HTML path) foregrounds the tab so it lands in active-group order and publishes to mobile.
          // Agent/automation opens stay in the background (activate:false) in the active browser group.
          const workspace = store.createBrowserTab(worktreeId, data.url, {
            title: data.url,
            targetGroupId: data.activate ? undefined : activeBrowserUnifiedTab?.groupId,
            sessionProfileId: data.sessionProfileId,
            sessionPartition: data.sessionPartition,
            activate: data.activate === true
          })
          // Why: registerGuest fires with the page ID, not the workspace ID; return it so waitForTabRegistration can correlate.
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
          // Why: a workspace may host several browser pages; profile switch must tear down all sibling webviews, not just the IPC's.
          const workspacePages = store.browserPagesByWorkspace[owningWorkspace.id] ?? []
          if (workspacePages.length > 0) {
            for (const page of workspacePages) {
              destroyPersistentWebview(page.id)
            }
          } else {
            destroyPersistentWebview(data.browserPageId)
          }
          store.switchBrowserTabProfile(owningWorkspace.id, data.profileId, data.sessionPartition)
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
          // Why: the bridge keys tabs by browserPageId, but closeBrowserTab expects a workspace id.
          // Per the CLI's `tab close --page` contract, close only that page unless it is the last in its workspace.
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
          // Why: mirror Terminal.tsx handleNewTab so a new tab appends at the end, not index 0, when tabBarOrder is unset.
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

    let initialRateLimitsSnapshotPending = true
    let receivedRateLimitsPushBeforeInitialSnapshot = false
    unsubs.push(
      window.api.rateLimits.onUpdate((state) => {
        if (initialRateLimitsSnapshotPending) {
          receivedRateLimitsPushBeforeInitialSnapshot = true
        }
        useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
      })
    )
    // Why: the startup get is a fallback; a live push may already include account snapshots the get result lacks.
    window.api.rateLimits.get().then((state) => {
      initialRateLimitsSnapshotPending = false
      if (receivedRateLimitsPushBeforeInitialSnapshot) {
        return
      }
      useAppStore.getState().setRateLimitsFromPush(state as RateLimitState)
    })

    const unsubscribeWorkspaceSpaceProgress = window.api.workspaceSpace?.onProgress?.(
      (progress) => {
        useAppStore.getState().applyWorkspaceSpaceProgress(progress)
      }
    )
    if (unsubscribeWorkspaceSpaceProgress) {
      unsubs.push(unsubscribeWorkspaceSpaceProgress)
    }

    // Why: hydrate initial SSH state for all targets so worktree cards show correct connect state on launch.
    void (async () => {
      try {
        const targets = await window.api.ssh.listTargets()
        useAppStore.getState().setSshTargetsMetadata(targets)
        // Why: ghost-host UI (removed target still referenced by a workspace) shows a tombstone name instead of the raw id.
        try {
          const removedLabels = await window.api.ssh.listRemovedTargetLabels()
          useAppStore.getState().setRemovedSshTargetLabels(removedLabels)
        } catch {
          // Best-effort — a missing map just falls back to the raw target id.
        }
        for (const target of targets) {
          const state = await window.api.ssh.getState({ targetId: target.id })
          if (state) {
            useAppStore.getState().setSshConnectionState(target.id, state as SshConnectionState)
            // Why: ports arrive only via push events; on reattach to a live session fetch snapshots or the Ports panel shows empty.
            if ((state as SshConnectionState).status === 'connected') {
              const [forwards, detected] = await Promise.all([
                window.api.ssh.listPortForwards({ targetId: target.id }),
                window.api.ssh.listDetectedPorts({ targetId: target.id })
              ])
              // Why: if the session disconnected while awaiting the snapshot, applying it would resurrect a dead session's ports.
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
        // Why: remote agent list is tied to a live relay; clear on disconnect so reconnect re-detects against the new relay.
        store.clearRemoteDetectedAgents(targetId)

        // Why: defensive — clear port state in case the removeAllForwards broadcast races this state change.
        store.clearPortForwards(targetId)
        store.setDetectedPorts(targetId, [])

        // Why: SSH teardown fires no per-PTY exit events; clear stale PTY ids so reconnect remounts rather than reattach a dead PTY.
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
          // Why: panes that never spawned (no PTY provider at cold start) or whose deferred reattach never ran sit inert.
          // Bumping generation remounts TerminalPane so the deferred-connect gate reattaches or spawns fresh now that the provider exists.
          const freshStore = useAppStore.getState()
          const remoteRepoIds = new Set(remoteRepos.map((r) => r.id))
          const worktreeIds = Object.values(freshStore.worktreesByRepo)
            .flat()
            .filter((w) => remoteRepoIds.has(w.repoId))
            .map((w) => w.id)

          for (const worktreeId of worktreeIds) {
            const tabs = freshStore.tabsByWorktree[worktreeId] ?? []
            const needsRetry = (t: { id: string; ptyId?: string | null }): boolean =>
              shouldRetryPaneSpawnOnSshReconnect({
                targetId,
                tabPtyId: t.ptyId,
                deferredSessionId: freshStore.deferredSshSessionIdsByTabId[t.id]
              })
            if (tabs.some(needsRetry)) {
              useAppStore.setState((s) => ({
                tabsByWorktree: {
                  ...s.tabsByWorktree,
                  [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((t) =>
                    needsRetry(t) ? { ...t, generation: (t.generation ?? 0) + 1 } : t
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

    handleSshStateChangedEvent = (data: { targetId: string; state: unknown }): void => {
      const store = useAppStore.getState()
      const state = data.state as SshConnectionState
      const stateEventId = ++sshTargetStateEventId
      latestSshTargetStateEventByTargetId.set(data.targetId, stateEventId)
      if (!store.sshTargetLabels.has(data.targetId)) {
        // Why: unknown target id could be a post-boot add or a removed target racing disconnect; confirm with main first.
        window.api.ssh
          .listTargets()
          // Why: refresh doubles as a deletion guard; retry once so a transient IPC failure doesn't drop a real added-target event.
          .catch(() => window.api.ssh.listTargets())
          .then((targets) => {
            if (latestSshTargetStateEventByTargetId.get(data.targetId) !== stateEventId) {
              return
            }
            latestSshTargetStateEventByTargetId.delete(data.targetId)
            const latestStore = useAppStore.getState()
            if (!targets.some((target) => target.id === data.targetId)) {
              // Why: state events can race after target removal; absence from main's target list means deletion, not a new target.
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
    }

    unsubs.push(window.api.ssh.onStateChanged(handleSshStateChangedEvent))

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
            // Why: relay notifications can race the client-id IPC; self-originated writes must never bounce back into restore.
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
        const target = resolveZoomTarget({
          activeView,
          activeTabType,
          activeElement: document.activeElement
        })
        if (target === 'terminal') {
          return
        }
        if (target === 'editor') {
          const next = nextEditorFontZoomLevel(editorFontZoomLevel, direction)
          setEditorFontZoomLevel(next)
          void window.api.ui.set({ editorFontZoomLevel: next })

          // Why: mirror the editor's base font (terminalFontSize) + clamping so the overlay percent matches the rendered size.
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

    // Why: re-parse main-process agent status here so the renderer applies the same normalization regardless of hook vs OSC source.
    // Startup pushes are ignored until workspace session hydration finishes; the snapshot pull below replays main's cache once tab identity exists.
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
      // Why: guard re-entrancy — a subscriber firing mid-loop must not reprocess queued events the outer flush already owns.
      if (isFlushingAgentStatuses) {
        return
      }
      if (pendingAgentStatusEvents.length === 0) {
        return
      }
      isFlushingAgentStatuses = true
      try {
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
      } finally {
        isFlushingAgentStatuses = false
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
      if (isAgentStatusForRecentlyClosedTab(store, data.paneKey)) {
        return 'dropped'
      }
      const paneKey = resolveAgentPaneAuthorityKey(data.paneKey)
      const ownerTabId = parsePaneKey(paneKey)?.tabId ?? data.tabId
      const payload = normalizeAgentStatusPayload({
        state: data.state,
        prompt: data.prompt,
        agentType: data.agentType,
        toolName: data.toolName,
        toolInput: data.toolInput,
        // Why: the live AskUserQuestion prompt rides this field; omitting it drops the native question card on web/mobile.
        interactivePrompt: data.interactivePrompt,
        lastAssistantMessage: data.lastAssistantMessage,
        interrupted: data.interrupted,
        // Why: same trap as interactivePrompt — this rebuild is a field whitelist, so subagent child rows vanish if omitted.
        subagents: data.subagents
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
      } = resolvePaneKey(store, paneKey)
      if (!exists && data.worktreeId && hasRuntimeBackedWorktreeAttribution(data)) {
        // Why: orchestration worker hooks may carry worktree attribution before this renderer has a tab for the pane.
        // Require runtime identity too — worktreeId-only snapshots can be stale rows from closed/remounted panes.
        const fallbackOwnership = resolveWorktreeConnection(store, data.worktreeId)
        if (fallbackOwnership.worktreeExists) {
          owningWorktreeId = data.worktreeId
          repoConnectionId = fallbackOwnership.repoConnectionId
          repoConnectionResolved = fallbackOwnership.repoConnectionResolved
          exists = true
        }
      }
      if (!exists) {
        // Why: a non-empty paneKey with no matching tab is a routing failure to track.
        // Skip during replay — main's durable cache legitimately holds closed-tab entries.
        if (options?.replay !== true) {
          if (options?.retry !== true) {
            track('agent_hook_unattributed', { reason: 'unknown_tab_id' })
            // Why: live hook IPC can beat tab/layout hydration; retry so a transient pane-key miss doesn't drop completion state.
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
      // Why: drop in-flight events stamped with a dead connection's id after SSH disconnect/reconnect — see docs/design/agent-status-over-ssh.md §5.
      // Why: startup snapshot replay can beat SSH repo hydration; accept when worktreeId matches the tab until repo ownership resolves.
      // Why: WSL relay stamps a `wsl:<distro>` connectionId but the pane is a local repo (ownership null); normalize so the strict check below doesn't drop it.
      const ownershipConnectionId = isWslHookRelayConnectionId(data.connectionId)
        ? null
        : data.connectionId
      const transientClearWatermark =
        typeof data.connectionId === 'string'
          ? transientClearWatermarkByConnectionId.get(data.connectionId)
          : undefined
      // Why: delayed snapshots/queued relay events must not resurrect a status cleared by a newer disconnect on this connection.
      if (transientClearWatermark !== undefined && data.receivedAt <= transientClearWatermark) {
        return 'dropped'
      }
      const canAcceptPendingRemoteOwnership =
        ownershipConnectionId !== undefined &&
        ownershipConnectionId !== null &&
        !repoConnectionResolved &&
        data.worktreeId !== undefined &&
        data.worktreeId === owningWorktreeId
      if (
        ownershipConnectionId !== undefined &&
        ownershipConnectionId !== repoConnectionId &&
        !canAcceptPendingRemoteOwnership
      ) {
        return 'dropped'
      }
      const existingStatus = store.agentStatusByPaneKey[paneKey]
      if (existingStatus && data.receivedAt < existingStatus.updatedAt) {
        // Why: the store rejects out-of-order status rows; keep metadata-only session identity on the same event boundary.
        return 'dropped'
      }
      if (data.providerSessionOnly) {
        if (!data.providerSession || data.agentType !== 'pi') {
          return 'dropped'
        }
        store.recordAgentProviderSession(
          paneKey,
          'pi',
          data.providerSession,
          { updatedAt: data.receivedAt },
          {
            tabId: ownerTabId,
            worktreeId: data.worktreeId ?? owningWorktreeId,
            // Why: persist the WSL-normalized ownership id, not raw relay provenance; a `wsl:*` connectionId would misroute later resumes.
            ...(ownershipConnectionId !== undefined ? { connectionId: ownershipConnectionId } : {})
          },
          data.launchToken ? { launchToken: data.launchToken } : undefined
        )
        return 'applied'
      }
      const resolvedPayload = resolveHookPayloadAgentType(payload, identityTitle ?? title)
      const statusPayload = data.orchestration
        ? { ...resolvedPayload, orchestration: data.orchestration }
        : resolvedPayload
      const statusPayloadWithTurnBoundary = data.promptInteractionKey
        ? { ...statusPayload, promptInteractionKey: data.promptInteractionKey }
        : statusPayload
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
        // Why: guards against a stale main-process child completion resurrecting terminal status.
        return 'dropped'
      }
      if (
        shouldSuppressCodexAutoApprovalStatus(statusPayload, {
          paneKey,
          tabId: ownerTabId,
          terminalHandle: data.terminalHandle,
          launchToken: data.launchToken,
          providerSession: data.providerSession,
          existingProviderSession: existingStatus?.providerSession
        })
      ) {
        // Why: Codex yolo permission hooks are not user-actionable; they must not drive status, titles, badges, or notifications.
        return 'dropped'
      }
      const terminalTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
      const statusWorktreeId = data.worktreeId ?? owningWorktreeId
      store.setAgentStatus(
        paneKey,
        statusPayloadWithTurnBoundary,
        terminalTitle,
        {
          updatedAt: data.receivedAt,
          stateStartedAt: data.stateStartedAt
        },
        {
          tabId: ownerTabId,
          worktreeId: statusWorktreeId,
          terminalHandle: data.terminalHandle,
          ...(ownershipConnectionId !== undefined ? { connectionId: ownershipConnectionId } : {})
        },
        data.providerSession || data.launchToken
          ? {
              ...(data.providerSession ? { providerSession: data.providerSession } : {}),
              ...(data.launchToken ? { launchToken: data.launchToken } : {})
            }
          : undefined
      )
      applyResolvedAgentTerminalTitleToTab(store, paneKey, title, terminalTitle)
      if (options?.replay !== true && statusWorktreeId) {
        // Why: local Codex/Claude hooks arrive via this main-process IPC path, not the PTY OSC fallback, so task-complete notifications must observe accepted hook state here too.
        const notificationPayload =
          typeof data.stateStartedAt === 'number'
            ? { ...resolvedPayload, stateStartedAt: data.stateStartedAt }
            : resolvedPayload
        observeAgentHookCompletionForNotification({
          paneKey,
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
          if (agentStatusEffectDisposed || requestId !== snapshotRequestId) {
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
            if (agentStatusEffectDisposed || requestId !== snapshotRequestId) {
              return
            }
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
          // Why: stay latched on failure; the store subscriber fires on every update, so resetting here would turn a persistent IPC failure into a retry storm (flag clears on workspaceSessionReady toggle).
          console.warn('[agent-status] failed to load startup snapshot:', err)
        })
    }

    unsubs.push(
      window.api.agentStatus.onSet((data) => {
        applyAgentStatus(data)
      })
    )
    const unsubscribeAgentStatusClear = window.api.agentStatus.onClear?.(
      (data: AgentStatusClearIpcPayload) => {
        if (typeof data !== 'object' || data === null) {
          return
        }
        if ('transient' in data && data.transient === true) {
          if (
            typeof data.connectionId !== 'string' ||
            data.connectionId.length === 0 ||
            !Number.isFinite(data.clearedAt)
          ) {
            return
          }
          const previousWatermark =
            transientClearWatermarkByConnectionId.get(data.connectionId) ?? -1
          const effectiveWatermark = Math.max(previousWatermark, data.clearedAt)
          transientClearWatermarkByConnectionId.set(data.connectionId, effectiveWatermark)
          for (let index = pendingAgentStatusEvents.length - 1; index >= 0; index -= 1) {
            const pending = pendingAgentStatusEvents[index].data
            if (
              pending.connectionId === data.connectionId &&
              pending.receivedAt <= effectiveWatermark
            ) {
              pendingAgentStatusEvents.splice(index, 1)
            }
          }
          useAppStore.getState().clearTransientAgentStatuses(data.connectionId, effectiveWatermark)
          return
        }
        if (!('paneKey' in data) || typeof data.paneKey !== 'string') {
          return
        }
        const store = useAppStore.getState()
        if (store.agentStatusByPaneKey[data.paneKey]?.state === 'done') {
          return
        }
        store.removeAgentStatus(data.paneKey)
      }
    )
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

    // Why: main hook server is the durable source of truth; pull the snapshot only after tabs are ready so early startup pushes can be ignored, not buffered.
    requestAgentStatusSnapshotIfReady()
    unsubs.push(
      useAppStore.subscribe((state, previousState) => {
        requestAgentStatusSnapshotIfReady()
        flushPendingAgentStatuses()
        syncAgentHookCompletionNotificationsForStoreUpdate(state, previousState)
      })
    )

    let mobileStateHydrated = isRuntimeEnvironmentActive()
    type PendingMobileStateEvent =
      | {
          kind: 'fit'
          event: {
            ptyId: string
            mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
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
      // Why: mirror presence-lock driver state so TerminalPane / pty-connection guards know which PTYs are mobile-driven. See docs/mobile-presence-lock.md.
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

    // Why: subscribe before the snapshot round trip and buffer live events; otherwise an older snapshot could overwrite a newer live lock and hide the overlay.
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
      // Why: React remount can leave an older snapshot promise in flight; it must not write through after the replacement effect processes a clear.
      agentStatusEffectDisposed = true
      snapshotRequestId += 1
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

function tryMakePaneKey(tabId: string, leafId: string): string | null {
  try {
    return makePaneKey(tabId, leafId)
  } catch {
    return null
  }
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
  // Why: hook completion can arrive while the pane transport is unmounted; keep the tab label synced to the resolved state title.
  store.updateTabTitle(parsed.tabId, nextTitle)
}

/** Resolve a paneKey (tabId:leafId) to liveness, current title, owning worktree,
 *  and the owning repo's connectionId. Used for agent-type inference and to drop
 *  status updates for torn-down tabs or dead connections
 *  (see docs/design/agent-status-over-ssh.md §5). */
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
  // Why: keep "resolved to a local repo" distinct from "not hydrated yet" so callers filter strictly post-hydration but still accept SSH snapshots during the startup ownership gap.
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
  // Why: an empty layout snapshot from a worktree switch (tab/PTY still live) counts as missing metadata; a non-empty layout lacking the leaf still means closed.
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
  // Why: inactive worktrees can have a durable tab and live PTY while the layout is unmounted; hook state must still land there.
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  // Why: treat empty-string paneTitle as "no title" so the tab-level fallback fires; nullish-coalescing on '' would short-circuit and erase cached terminalTitle.
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  return {
    exists,
    title: paneTitle ?? tabTitle,
    // Why: some agents (OpenClaude) keep the terminal title generic while the tab label carries the agent identity; use only the non-custom label for attribution.
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
  // Why: OpenClaude emits Claude-compatible hooks; the title is the last renderer signal to keep it out of Claude-only status paths.
  return { ...payload, agentType: 'openclaude' }
}
