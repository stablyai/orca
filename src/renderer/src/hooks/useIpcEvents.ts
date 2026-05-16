/* oxlint-disable max-lines -- Why: this App-level IPC bridge intentionally keeps the renderer's main-process event contract in one place so shortcut, runtime, updater, and agent-status wiring do not drift across files. */
import { useEffect } from 'react'
import { useAppStore } from '../store'
import { getWorktreeMapFromState, getRepoMapFromState } from '@/store/selectors'
import { applyUIZoom } from '@/lib/ui-zoom'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { runSleepWorktree } from '@/components/sidebar/sleep-worktree-flow'
import { SPLIT_TERMINAL_PANE_EVENT, CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { SplitTerminalPaneDetail, CloseTerminalPaneDetail } from '@/constants/terminal'
import { getVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { nextEditorFontZoomLevel, computeEditorFontSize } from '@/lib/editor-font-zoom'
import type { UpdateStatus, WorkspaceSessionState } from '../../../shared/types'
import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../../shared/remote-workspace-types'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { SshConnectionState } from '../../../shared/ssh-types'
import type { RuntimeTerminalDriverState } from '../../../shared/runtime-types'
import { importRemoteWorkspaceSession } from '../../../shared/remote-workspace-session-projection'
import { zoomLevelToPercent, ZOOM_MIN, ZOOM_MAX } from '@/components/settings/SettingsConstants'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { resolveZoomTarget } from './resolve-zoom-target'
import {
  handleSwitchTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'
import {
  normalizeAgentStatusPayload,
  type AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { focusRuntimeTerminalSurface } from '@/runtime/sync-runtime-graph'
import { setFitOverride, hydrateOverrides } from '@/lib/pane-manager/mobile-fit-overrides'
import { setDriverForPty, hydrateDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { destroyPersistentWebview } from '@/components/browser-pane/webview-registry'
import { attachMobileMarkdownBridge } from '@/runtime/mobile-markdown-bridge'
import { detectLanguage } from '@/lib/language-detect'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { track } from '@/lib/telemetry'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'

export { resolveZoomTarget } from './resolve-zoom-target'

const ZOOM_STEP = 0.5
let remoteWorkspaceSnapshotApplyDepth = 0
let remoteWorkspaceSnapshotWriteSuppressUntil = 0
const REMOTE_WORKSPACE_SNAPSHOT_WRITE_SUPPRESS_MS = 1000

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
      message: 'Workspace synced'
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
  if (store.sshTargetRemoteSyncEnabled.get(targetId) !== true) {
    return
  }
  if (!(await prepareRemoteWorkspaceTarget(targetId))) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'error',
      direction: 'pull',
      message: 'Workspace sync waited for local session hydration and timed out'
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
      message: 'Remote workspace sync unavailable'
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
    message: 'No remote workspace yet'
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
      message: 'Remote workspace sync unavailable'
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
      message: 'Workspace uploaded'
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

function isRuntimeEnvironmentActive(): boolean {
  return Boolean(useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim())
}

export function useIpcEvents(): void {
  useEffect(() => {
    const unsubs: (() => void)[] = []

    unsubs.push(attachMobileMarkdownBridge())

    unsubs.push(
      window.api.repos.onChanged(() => {
        if (isRuntimeEnvironmentActive()) {
          // Why: this event comes from the local Electron store. While a
          // runtime server is selected, repo hydration must be driven by the
          // selected server instead of local-disk changes.
          return
        }
        useAppStore.getState().fetchRepos()
      })
    )

    unsubs.push(
      window.api.worktrees.onChanged(async (data: { repoId: string }) => {
        if (isRuntimeEnvironmentActive()) {
          // Why: local worktree events carry local repo ids. Fetching the
          // active runtime with those ids can purge or overwrite server state.
          return
        }
        // Why: diff before vs. after fetchWorktrees to detect server-side
        // deletions (CLI `orca worktree rm`, other window, out-of-band RPC)
        // and purge worktree-scoped state for removed ids. Without this,
        // `ptyIdsByTabId` would retain entries for tabs whose worktree is
        // gone, and SessionsStatusSegment's `boundPtyIds` set would keep
        // misclassifying the zombie as bound (design §2c, §4.4).
        const state = useAppStore.getState()
        const before = new Set((state.worktreesByRepo[data.repoId] ?? []).map((w) => w.id))
        await state.fetchWorktrees(data.repoId)
        await useAppStore.getState().fetchWorktreeLineage()
        const afterState = useAppStore.getState()
        const after = new Set((afterState.worktreesByRepo[data.repoId] ?? []).map((w) => w.id))
        const removed: string[] = []
        for (const id of before) {
          if (!after.has(id)) {
            removed.push(id)
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
      })
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

    unsubs.push(
      window.api.ui.onOpenSettings(() => {
        useAppStore.getState().openSettingsPage()
      })
    )

    unsubs.push(
      window.api.ui.onOpenFeatureTour(() => {
        useAppStore.getState().openModal('feature-wall', { source: 'help_menu' })
      })
    )

    unsubs.push(
      window.api.ui.onShowFeatureTourNudge(() => {
        useAppStore.getState().showFeatureTourNudge()
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

    unsubs.push(
      window.api.ui.onToggleLeftSidebar(() => {
        useAppStore.getState().toggleSidebar()
      })
    )

    unsubs.push(
      window.api.ui.onToggleRightSidebar(() => {
        useAppStore.getState().toggleRightSidebar()
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
        // Why: mirror the renderer's App.tsx Cmd+N guard — only open the
        // composer when there is at least one real git repo configured, so
        // users on a fresh install don't get a modal with nothing to target.
        const store = useAppStore.getState()
        if (!store.repos.some((repo) => isGitRepoKind(repo))) {
          return
        }
        if (store.activeModal === 'new-workspace-composer') {
          return
        }
        store.openModal('new-workspace-composer', { telemetrySource: 'shortcut' })
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
      window.api.ui.onActivateWorktree(({ repoId, worktreeId, setup, startup }) => {
        void (async () => {
          if (isRuntimeEnvironmentActive()) {
            // Why: local CLI-created worktree events carry local repo/worktree
            // ids. Runtime server activation arrives through runtime state,
            // not this local Electron event.
            return
          }
          // Why: fetch worktrees first so the activation helper can resolve
          // the CLI-created worktree via findWorktreeById — it arrived from
          // the main process and is not yet in the renderer state.
          await useAppStore.getState().fetchWorktrees(repoId)
          // Why: route through activateAndRevealWorktree so CLI-created
          // worktrees share the canonical activation path with UI-created
          // ones. This records the visit in the back/forward history stack
          // (recordWorktreeVisit), without which the nav buttons would
          // ignore the CLI-driven workspace switch.
          activateAndRevealWorktree(worktreeId, { setup, startup })
        })().catch((error) => {
          console.error('Failed to activate CLI-created worktree:', error)
        })
      })
    )

    unsubs.push(
      window.api.ui.onCreateTerminal(
        ({ requestId, worktreeId, command, title, ptyId, activate, tabId, leafId }) => {
          try {
            if (isRuntimeEnvironmentActive()) {
              if (requestId) {
                window.api.ui.replyTerminalCreate({
                  requestId,
                  error: 'Local terminal reveal is unavailable while a remote runtime is active'
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
            const tab = ptyId
              ? ((store.tabsByWorktree[worktreeId] ?? []).find(
                  (candidate) =>
                    candidate.ptyId === ptyId ||
                    (store.ptyIdsByTabId[candidate.id] ?? []).includes(ptyId)
                ) ??
                store.createTab(worktreeId, undefined, undefined, {
                  initialPtyId: ptyId,
                  activate: shouldActivate,
                  // Why: tabId hint comes from CLI-spawned PTYs whose env
                  // already has the pane key baked in. Adopting the tab under
                  // the same id keeps hook-event attribution working.
                  ...(tabId !== undefined ? { id: tabId } : {})
                }))
              : store.createTab(worktreeId)
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
            if (title) {
              store.setTabCustomTitle(tab.id, title)
            }
            if (leafId && ptyId) {
              // Why: CLI/runtime-spawned PTYs emit hook events before a hidden
              // tab mounts TerminalPane, so the adopted UUID leaf must exist
              // in layout state for paneKey validation to accept them.
              store.setTabLayout(tab.id, singlePaneLayoutSnapshot(leafId, ptyId, title))
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
              error: 'Local terminal creation is unavailable while a remote runtime is active'
            })
            return
          }
          const store = useAppStore.getState()
          const worktreeId = data.worktreeId ?? store.activeWorktreeId
          if (!worktreeId) {
            window.api.ui.replyTerminalCreate({
              requestId: data.requestId,
              error: 'No active worktree'
            })
            return
          }
          store.setActiveView('terminal')
          store.setActiveWorktree(worktreeId)
          // Why: CLI-driven terminal-create request is user-initiated; stamp
          // focus recency for Cmd+J. See docs/cmd-j-empty-query-ordering.md.
          store.markWorktreeVisited(worktreeId)
          const tab = store.createTab(worktreeId)
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
              useAppStore.getState().reorderUnifiedTabs(createdUnifiedTab.groupId, order)
            }
          }
          store.setActiveTabType('terminal')
          store.setActiveTab(tab.id)
          store.revealWorktreeInSidebar(worktreeId)
          if (data.title) {
            store.setTabCustomTitle(tab.id, data.title)
          }
          if (data.command) {
            store.queueTabStartupCommand(tab.id, { command: data.command })
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
      window.api.ui.onSplitTerminal(({ tabId, paneRuntimeId, direction, command }) => {
        const detail: SplitTerminalPaneDetail = { tabId, paneRuntimeId, direction, command }
        window.dispatchEvent(new CustomEvent(SPLIT_TERMINAL_PANE_EVENT, { detail }))
      })
    )

    unsubs.push(
      window.api.ui.onRenameTerminal(({ tabId, title }) => {
        useAppStore.getState().setTabCustomTitle(tabId, title)
      })
    )

    unsubs.push(
      window.api.ui.onFocusTerminal(({ tabId, worktreeId, leafId }) => {
        const store = useAppStore.getState()
        store.setActiveWorktree(worktreeId)
        // Why: CLI-driven focus is a user-initiated switch; stamp focus
        // recency for Cmd+J. See docs/cmd-j-empty-query-ordering.md.
        store.markWorktreeVisited(worktreeId)
        store.setActiveView('terminal')
        store.setActiveTab(tabId)
        store.revealWorktreeInSidebar(worktreeId)
        if (!focusRuntimeTerminalSurface(tabId, leafId)) {
          focusTerminalTabSurface(tabId, leafId)
        }
      })
    )

    unsubs.push(
      window.api.ui.onFocusEditorTab(({ tabId, worktreeId }) => {
        const store = useAppStore.getState()
        const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (item) => item.id === tabId
        )
        if (!tab) {
          return
        }
        store.setActiveWorktree(worktreeId)
        store.markWorktreeVisited(worktreeId)
        store.setActiveView('terminal')
        store.focusGroup(worktreeId, tab.groupId)
        store.activateTab(tab.id)
        store.setActiveFile(tab.entityId)
        store.setActiveTabType('editor')
        store.revealWorktreeInSidebar(worktreeId)
      })
    )

    unsubs.push(
      window.api.ui.onCloseSessionTab(({ tabId }) => {
        useAppStore.getState().closeUnifiedTab(tabId)
      })
    )

    unsubs.push(
      window.api.ui.onOpenFileFromMobile(({ worktreeId, filePath, relativePath }) => {
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
          mode: 'edit'
        })
        store.setActiveTabType('editor')
        store.revealWorktreeInSidebar(worktreeId)
      })
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
          useAppStore.getState().closeTab(tabId)
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
    // has display != none. After app restart, activeTabType defaults to 'terminal'
    // so persisted browser tabs never mount. The main process sends this IPC
    // before browser commands so the webview can start and registerGuest fires.
    unsubs.push(
      window.api.browser.onActivateView(() => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        useAppStore.getState().setActiveTabType('browser')
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
        if (isRuntimeEnvironmentActive()) {
          return
        }
        const store = useAppStore.getState()
        const sourcePage = Object.values(store.browserPagesByWorkspace)
          .flat()
          .find((page) => page.id === browserPageId)
        if (!sourcePage) {
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
        if (isRuntimeEnvironmentActive()) {
          return
        }
        const store = useAppStore.getState()
        const worktreeId = store.activeWorktreeId
        if (worktreeId) {
          store.createBrowserTab(worktreeId, store.browserDefaultUrl ?? 'about:blank', {
            title: 'New Browser Tab',
            focusAddressBar: true
          })
        }
      })
    )

    // Why: CLI-driven tab creation sends a request with a specific worktreeId and
    // url. The renderer creates the tab and replies with the workspace ID so the
    // main process can wait for registerGuest before returning to the CLI.
    unsubs.push(
      window.api.ui.onRequestTabCreate((data) => {
        try {
          if (isRuntimeEnvironmentActive()) {
            // Why: browser automation targets client-local Electron webviews.
            // Runtime agents cannot see or control those surfaces.
            window.api.ui.replyTabCreate({
              requestId: data.requestId,
              error: 'Browser tabs are unavailable while a remote runtime is active'
            })
            return
          }
          const store = useAppStore.getState()
          const worktreeId = data.worktreeId ?? store.activeWorktreeId
          if (!worktreeId) {
            window.api.ui.replyTabCreate({ requestId: data.requestId, error: 'No active worktree' })
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

          const workspace = store.createBrowserTab(worktreeId, data.url, {
            title: data.url,
            targetGroupId: activeBrowserUnifiedTab?.groupId,
            sessionProfileId: data.sessionProfileId
          })
          // Why: registerGuest fires with the page ID (not workspace ID) as
          // browserPageId. Return the page ID so waitForTabRegistration can
          // correlate correctly.
          const pages = useAppStore.getState().browserPagesByWorkspace[workspace.id] ?? []
          const browserPageId = pages[0]?.id ?? workspace.id
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
              error: 'Browser profiles are unavailable while a remote runtime is active'
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
              error: `Browser tab ${data.browserPageId} not found`
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
              error: 'Browser tabs are unavailable while a remote runtime is active'
            })
            return
          }
          const store = useAppStore.getState()
          const explicitTargetId = data.tabId ?? null
          let tabToClose =
            explicitTargetId ??
            (data.worktreeId
              ? (store.activeBrowserTabIdByWorktree?.[data.worktreeId] ?? null)
              : store.activeBrowserTabId)
          if (!tabToClose) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: 'No active browser tab to close'
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
                store.closeBrowserTab(workspaceId)
              } else {
                store.closeBrowserPage(tabToClose)
              }
              window.api.ui.replyTabClose({ requestId: data.requestId })
              return
            }
          }
          if (explicitTargetId) {
            window.api.ui.replyTabClose({
              requestId: data.requestId,
              error: `Browser tab ${explicitTargetId} not found`
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
        const worktreeId = store.activeWorktreeId
        if (!worktreeId) {
          return
        }
        const newTab = store.createTab(worktreeId)
        store.setActiveTabType('terminal')
        // Why: replicate the full reconciliation from Terminal.tsx handleNewTab
        // so the new tab appends at the visual end instead of jumping to index 0
        // when tabBarOrderByWorktree is unset (e.g. restored worktrees).
        const currentTerminals = store.tabsByWorktree[worktreeId] ?? []
        const currentEditors = store.openFiles.filter((f) => f.worktreeId === worktreeId)
        const currentBrowsers = store.browserTabsByWorktree[worktreeId] ?? []
        const stored = store.tabBarOrderByWorktree[worktreeId]
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
        store.setTabBarOrder(worktreeId, order)
        focusTerminalTabSurface(newTab.id)
      })
    )

    unsubs.push(
      window.api.ui.onCloseActiveTab(() => {
        const store = useAppStore.getState()
        if (store.activeTabType === 'browser' && store.activeBrowserTabId) {
          store.closeBrowserTab(store.activeBrowserTabId)
        }
      })
    )

    unsubs.push(window.api.ui.onSwitchTab(handleSwitchTab))
    unsubs.push(window.api.ui.onSwitchTabAcrossAllTypes(handleSwitchTabAcrossAllTypes))
    unsubs.push(window.api.ui.onSwitchTerminalTab(handleSwitchTerminalTab))

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
              if (target.remoteWorkspaceSyncEnabled) {
                void syncRemoteWorkspaceAfterConnect(target.id).catch((err) => {
                  useAppStore.getState().setRemoteWorkspaceSyncStatus(target.id, {
                    phase: 'error',
                    message: err instanceof Error ? err.message : 'Workspace sync failed'
                  })
                })
              }
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

    unsubs.push(
      window.api.ssh.onStateChanged((data: { targetId: string; state: unknown }) => {
        const store = useAppStore.getState()
        const state = data.state as SshConnectionState
        store.setSshConnectionState(data.targetId, state)
        const remoteRepos = store.repos.filter((r) => r.connectionId === data.targetId)

        // Why: targets added after boot aren't in the labels map. Re-fetch
        // so the status bar popover shows the new target immediately.
        if (!store.sshTargetLabels.has(data.targetId)) {
          window.api.ssh
            .listTargets()
            .then((targets) => {
              useAppStore.getState().setSshTargetsMetadata(targets)
            })
            .catch(() => {})
        }

        if (
          ['disconnected', 'auth-failed', 'reconnection-failed', 'error'].includes(state.status)
        ) {
          // Why: the remote agent list is tied to a live SSH connection. On
          // disconnect the relay is gone, so clear the cached list and dedup
          // promise. When the user reconnects and opens the quick-launch menu,
          // ensureRemoteDetectedAgents will re-detect against the new relay.
          store.clearRemoteDetectedAgents(data.targetId)

          // Why: defensive — clear port forward and detected port state in case
          // the broadcast from removeAllForwards races with the state change.
          store.clearPortForwards(data.targetId)
          store.setDetectedPorts(data.targetId, [])

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
          // Why: the file explorer may have tried (and failed) to load the tree
          // before the SSH connection was established. Bumping the generation
          // lets it detect that providers are now available and retry.
          store.bumpSshConnectedGeneration()

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
            void syncRemoteWorkspaceAfterConnect(data.targetId).catch((err) => {
              useAppStore.getState().setRemoteWorkspaceSyncStatus(data.targetId, {
                phase: 'error',
                message: err instanceof Error ? err.message : 'Workspace sync failed'
              })
            })
          })
        }
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
        const { activeView, activeTabType, editorFontZoomLevel, setEditorFontZoomLevel, settings } =
          useAppStore.getState()
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
    const applyAgentStatus = (
      data: AgentStatusIpcPayload,
      options?: { replay?: boolean }
    ): void => {
      const store = useAppStore.getState()
      if (!store.workspaceSessionReady) {
        return
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
        return
      }
      const { exists, title, repoConnectionId } = resolvePaneKey(store, data.paneKey)
      if (!exists) {
        // Why: empty paneKeys are dropped in main before IPC fanout. Reaching
        // this branch means a non-empty paneKey escaped without a matching
        // renderer tab, so track the adoption/routing failure separately.
        // Skipped during snapshot replay because main's durable cache may
        // include entries whose tabs were closed before this session — that
        // reconciliation miss is not a regression signal.
        if (options?.replay !== true) {
          track('agent_hook_unattributed', { reason: 'unknown_tab_id' })
        }
        return
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
      if (data.connectionId !== undefined && data.connectionId !== repoConnectionId) {
        return
      }
      store.setAgentStatus(data.paneKey, payload, title, {
        updatedAt: data.receivedAt,
        stateStartedAt: data.stateStartedAt
      })
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
    unsubs.push(useAppStore.subscribe(() => requestAgentStatusSnapshotIfReady()))

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
    const pendingMobileStateEvents: PendingMobileStateEvent[] = []

    const applyPendingMobileStateEvents = (): void => {
      for (const pending of pendingMobileStateEvents) {
        if (pending.kind === 'fit') {
          const { ptyId, mode, cols, rows } = pending.event
          setFitOverride(ptyId, mode, cols, rows)
        } else {
          setDriverForPty(pending.event.ptyId, pending.event.driver)
        }
      }
      pendingMobileStateEvents.length = 0
    }

    unsubs.push(
      window.api.runtime.onTerminalFitOverrideChanged((event) => {
        if (isRuntimeEnvironmentActive()) {
          return
        }
        if (!mobileStateHydrated) {
          pendingMobileStateEvents.push({ kind: 'fit', event })
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
          pendingMobileStateEvents.push({ kind: 'driver', event })
          return
        }
        setDriverForPty(event.ptyId, event.driver)
      })
    )

    // Why: hydrate mobile-owned terminal state on renderer reload. Subscribe
    // first and buffer live events during the snapshot round trip; otherwise an
    // older snapshot could overwrite a newer live lock and hide the overlay.
    if (!isRuntimeEnvironmentActive()) {
      void Promise.all([
        window.api.runtime.getTerminalFitOverrides(),
        window.api.runtime.getTerminalDrivers()
      ])
        .then(([overrides, drivers]) => {
          hydrateOverrides(overrides)
          hydrateDrivers(drivers)
          mobileStateHydrated = true
          applyPendingMobileStateEvents()
        })
        .catch((error: unknown) => {
          console.error('Failed to hydrate mobile terminal state:', error)
          mobileStateHydrated = true
          applyPendingMobileStateEvents()
        })
    }

    return () => unsubs.forEach((fn) => fn())
  }, [])
}

/** Resolve a paneKey (tabId:leafId) to both a liveness check and the current
 *  title, and the connectionId of the repo that owns the pane's worktree.
 *  Walks tabsByWorktree to locate the tab, then resolves the owning worktree
 *  and repo via cached selector maps. Used for agent type inference when the
 *  CLI payload omits agentType, plus to drop status updates targeted at panes
 *  whose tabs have already been torn down or whose owning connection is no
 *  longer live (see docs/design/agent-status-over-ssh.md §5).
 *  Why combined: callers need all three pieces per hook event, and hook
 *  events can fire many times per second during a tool-use run. Bundling
 *  liveness + title + connectionId into one helper keeps the per-event work
 *  in one place and avoids re-deriving the owning repo at the call site. */
function resolvePaneKey(
  store: ReturnType<typeof useAppStore.getState>,
  paneKey: string
): { exists: boolean; title: string | undefined; repoConnectionId: string | null } {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return { exists: false, title: undefined, repoConnectionId: null }
  }
  const { tabId, leafId } = parsed
  const layout = store.terminalLayoutsByTabId?.[tabId]
  const leafExists = collectLeafIdsInOrder(layout?.root).includes(leafId)
  if (!leafExists) {
    return { exists: false, title: undefined, repoConnectionId: null }
  }
  // Why: replay can remint numeric pane ids, so status title recovery must use
  // persisted leaf-keyed titles when crossing from hook state into tab state.
  const rawPaneTitle = layout?.titlesByLeafId?.[leafId]
  // Why: treat an empty-string paneTitle as "no title" so the tab-level
  // fallback still fires. `paneTitle ?? tabTitle` alone would short-circuit on
  // '' and also erase any previously-cached terminalTitle in the store
  // (`terminalTitle ?? existing?.terminalTitle` resolves to '').
  const paneTitle = rawPaneTitle && rawPaneTitle.length > 0 ? rawPaneTitle : undefined
  let exists = false
  let tabTitle: string | undefined
  let owningWorktreeId: string | undefined
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.id === tabId) {
        exists = true
        tabTitle = tab.title
        owningWorktreeId = worktreeId
        break
      }
    }
    if (exists) {
      break
    }
  }
  // Why: ownership lookup is `tab → worktree → repo → repo.connectionId`.
  // Treat unknown owner (no matching worktree/repo) as `null` so remote
  // events stamped with a string connectionId are dropped by the caller —
  // we cannot prove they belong to the currently-live local repo.
  let repoConnectionId: string | null = null
  if (owningWorktreeId !== undefined) {
    const worktree = getWorktreeMapFromState(store).get(owningWorktreeId)
    if (worktree) {
      const repo = getRepoMapFromState(store).get(worktree.repoId)
      repoConnectionId = repo?.connectionId ?? null
    }
  }
  return { exists, title: paneTitle ?? tabTitle, repoConnectionId }
}
