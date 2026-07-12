import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator'
import type {
  AgentCompletionCoordinator,
  AgentCompletionStatusSnapshot
} from '@/components/terminal-pane/agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { createCodexAutoApprovalHookCompletionSuppressor } from '@/components/terminal-pane/codex-auto-approval-notification-suppression'
import { dispatchAgentHookTerminalLifecycle } from '@/components/terminal-pane/agent-hook-terminal-lifecycle'
import {
  shouldSyncAgentHookCompletionForStoreUpdate,
  type AgentHookCompletionStoreSnapshot
} from './agent-hook-completion-store-sync'

type CoordinatorEntry = {
  worktreeId: string
  coordinator: AgentCompletionCoordinator
}

type StoreSnapshot = ReturnType<typeof useAppStore.getState>
type WorktreeTab = NonNullable<StoreSnapshot['tabsByWorktree']>[string][number]
// Why: a paneKey resolves to a tab by id. Prebuilding this index once per prune
// pass avoids re-flattening tabsByWorktree per coordinator (O(coordinators x
// tabs)) when a liveness or notification-setting update requires a prune.
type TabIndex = ReadonlyMap<string, WorktreeTab>
type PaneCoordinatorLivenessSnapshot = Pick<
  StoreSnapshot,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'suppressedPtyExitIds'
>

const coordinatorsByPaneKey = new Map<string, CoordinatorEntry>()
const paneKeysRequiringFreshWorking = new Set<string>()
let wasAgentTaskCompleteTrackingEnabled = isAgentTaskCompleteTrackingEnabled()
let requireFreshWorkingForNewTrackingCoordinators = !wasAgentTaskCompleteTrackingEnabled
let lastPrunedLivenessSnapshot: PaneCoordinatorLivenessSnapshot | null = null

function disposeCoordinatorForPaneKey(paneKey: string): void {
  coordinatorsByPaneKey.get(paneKey)?.coordinator.dispose()
  coordinatorsByPaneKey.delete(paneKey)
  paneKeysRequiringFreshWorking.delete(paneKey)
}

function buildTabIndex(tabsByWorktree: StoreSnapshot['tabsByWorktree']): TabIndex {
  const index = new Map<string, WorktreeTab>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      // Why: first-wins to match the previous Array.flat().find() semantics
      // exactly, even in the degenerate case of a tab id shared across worktrees.
      if (!index.has(tab.id)) {
        index.set(tab.id, tab)
      }
    }
  }
  return index
}

function pruneClosedPaneCoordinators(): void {
  // Why: hook-completion coordinators are module-scoped and may outlive a pane
  // unless liveness changes from close/sleep paths evict them here.
  if (coordinatorsByPaneKey.size === 0 && paneKeysRequiringFreshWorking.size === 0) {
    lastPrunedLivenessSnapshot = null
    return
  }
  const state = useAppStore.getState()
  const livenessSnapshot: PaneCoordinatorLivenessSnapshot = {
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    suppressedPtyExitIds: state.suppressedPtyExitIds
  }
  if (
    lastPrunedLivenessSnapshot?.tabsByWorktree === livenessSnapshot.tabsByWorktree &&
    lastPrunedLivenessSnapshot.ptyIdsByTabId === livenessSnapshot.ptyIdsByTabId &&
    lastPrunedLivenessSnapshot.terminalLayoutsByTabId === livenessSnapshot.terminalLayoutsByTabId &&
    lastPrunedLivenessSnapshot.suppressedPtyExitIds === livenessSnapshot.suppressedPtyExitIds
  ) {
    return
  }
  lastPrunedLivenessSnapshot = livenessSnapshot
  // Why: build the paneKey->tab index once for the whole pass instead of
  // re-flattening tabsByWorktree inside paneCanReceiveHookCompletion per entry.
  const tabIndex = buildTabIndex(livenessSnapshot.tabsByWorktree)
  for (const paneKey of coordinatorsByPaneKey.keys()) {
    if (!paneCanReceiveHookCompletion(paneKey, tabIndex)) {
      disposeCoordinatorForPaneKey(paneKey)
    }
  }
  for (const paneKey of paneKeysRequiringFreshWorking) {
    if (!paneCanReceiveHookCompletion(paneKey, tabIndex)) {
      paneKeysRequiringFreshWorking.delete(paneKey)
    }
  }
  if (coordinatorsByPaneKey.size === 0 && paneKeysRequiringFreshWorking.size === 0) {
    lastPrunedLivenessSnapshot = null
  }
}

function isAgentTaskCompleteNotificationEnabled(): boolean {
  const notifications = useAppStore.getState().settings?.notifications
  return notifications?.enabled !== false && notifications?.agentTaskComplete !== false
}

function isTerminalAttentionEnabled(): boolean {
  return useAppStore.getState().settings?.experimentalTerminalAttention === true
}

function isAgentTaskCompleteTrackingEnabled(): boolean {
  return isAgentTaskCompleteNotificationEnabled() || isTerminalAttentionEnabled()
}

export function syncAgentHookCompletionNotificationSettings(): boolean {
  pruneClosedPaneCoordinators()
  const enabled = isAgentTaskCompleteTrackingEnabled()
  if (enabled !== wasAgentTaskCompleteTrackingEnabled) {
    requireFreshWorkingForNewTrackingCoordinators = true
    for (const paneKey of coordinatorsByPaneKey.keys()) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  wasAgentTaskCompleteTrackingEnabled = enabled
  return enabled
}

export function syncAgentHookCompletionNotificationsForStoreUpdate(
  current: AgentHookCompletionStoreSnapshot,
  previous: AgentHookCompletionStoreSnapshot
): boolean {
  // Why: Zustand also publishes high-rate title/status writes that cannot make
  // module-scoped completion coordinators stale.
  if (!shouldSyncAgentHookCompletionForStoreUpdate(current, previous)) {
    return false
  }
  syncAgentHookCompletionNotificationSettings()
  return true
}

function getPtyIdForPaneKey(paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  const state = useAppStore.getState()
  const tabPtyIds = state.ptyIdsByTabId?.[parsed.tabId]
  if (!tabPtyIds || tabPtyIds.length === 0) {
    return null
  }
  // Why: split-pane leaves share one tab-level pty list, so a tab-level lookup
  // would return a sibling's pty for an already-closed leaf and let a late
  // 'done' hook event fire a spurious notification. Resolve liveness through
  // the leaf-keyed binding maintained by syncPanePtyLayoutBinding, which
  // deletes the entry when the leaf closes.
  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId
  if (ptyIdsByLeafId) {
    const leafPtyId = ptyIdsByLeafId[parsed.leafId]
    if (leafPtyId && tabPtyIds.includes(leafPtyId)) {
      return leafPtyId
    }
    if (!layout?.root) {
      // Why: inactive worktree switches can temporarily preserve only tab-level
      // PTY liveness; do not drop hook completions just because layout metadata
      // is at the empty snapshot.
      return tabPtyIds[0] ?? null
    }
    // Why: switching worktrees can unmount the terminal pane and clear the
    // leaf binding before the hook completion arrives, while the tab PTY is
    // still live. Keep closed leaves suppressed by requiring the leaf in layout.
    return collectLeafIdsInOrder(layout.root).includes(parsed.leafId)
      ? (tabPtyIds[0] ?? null)
      : null
  }
  return tabPtyIds[0] ?? null
}

function paneHasLivePty(paneKey: string): boolean {
  return getPtyIdForPaneKey(paneKey) !== null
}

function resolveTabById(
  state: StoreSnapshot,
  tabId: string,
  tabIndex?: TabIndex
): WorktreeTab | undefined {
  if (tabIndex) {
    return tabIndex.get(tabId)
  }
  for (const tabs of Object.values(state.tabsByWorktree ?? {})) {
    const found = tabs.find((candidate) => candidate.id === tabId)
    if (found) {
      return found
    }
  }
  return undefined
}

function paneKeyHasUnsuppressedPtyHint(
  state: StoreSnapshot,
  paneKey: string,
  tabIndex?: TabIndex
): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const tab = resolveTabById(state, parsed.tabId, tabIndex)
  if (!tab) {
    return false
  }
  const layout = state.terminalLayoutsByTabId?.[parsed.tabId]
  if (layout?.root && !collectLeafIdsInOrder(layout.root).includes(parsed.leafId)) {
    return false
  }
  const leafPtyId = layout?.ptyIdsByLeafId?.[parsed.leafId]
  // Why: sleep/shutdown preserves tab records while marking their PTYs
  // suppressed. Missing hints are allowed because inactive-worktree hydration
  // can accept hook status before the renderer restores tab PTY metadata.
  const ptyHints = [tab.ptyId, leafPtyId].filter((ptyId): ptyId is string => Boolean(ptyId))
  return ptyHints.length === 0 || ptyHints.some((ptyId) => !state.suppressedPtyExitIds?.[ptyId])
}

function paneCanReceiveHookCompletion(paneKey: string, tabIndex?: TabIndex): boolean {
  const state = useAppStore.getState()
  // Why: native hook IPC is itself a live status signal. Inactive worktrees can
  // have accepted hook updates before their renderer PTY map catches up.
  return paneKeyHasUnsuppressedPtyHint(state, paneKey, tabIndex) || paneHasLivePty(paneKey)
}

function createCoordinator(paneKey: string, worktreeId: string): AgentCompletionCoordinator {
  return createAgentCompletionCoordinator({
    paneKey,
    getPtyId: () => getPtyIdForPaneKey(paneKey),
    getSettings: () => useAppStore.getState().settings,
    inspectProcess: async (): Promise<RuntimeTerminalProcessInspection> => ({
      foregroundProcess: null,
      hasChildProcesses: false
    }),
    dispatchHookLifecycle: (payload) => dispatchAgentHookTerminalLifecycle(paneKey, payload),
    dispatchCompletion: (title, meta) => {
      if (!isAgentTaskCompleteTrackingEnabled() || paneKeysRequiringFreshWorking.has(paneKey)) {
        return
      }
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        suppressOsNotification: !isAgentTaskCompleteNotificationEnabled(),
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    dispatchAttention: (title, meta) => {
      if (!isAgentTaskCompleteTrackingEnabled() || paneKeysRequiringFreshWorking.has(paneKey)) {
        return
      }
      // Why: native notification settings still label this channel as "agent
      // task complete"; the snapshot state makes the banner read "needs input".
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        suppressOsNotification: !isAgentTaskCompleteNotificationEnabled(),
        agentStatusSnapshot: meta.agentStatus
      })
    },
    isLive: () => paneCanReceiveHookCompletion(paneKey),
    shouldSuppressHookCompletion: createCodexAutoApprovalHookCompletionSuppressor(paneKey)
  })
}

export function observeAgentHookCompletionForNotification({
  paneKey,
  worktreeId,
  payload
}: {
  paneKey: string
  worktreeId: string
  payload: AgentCompletionStatusSnapshot
}): void {
  pruneClosedPaneCoordinators()
  if (!paneCanReceiveHookCompletion(paneKey)) {
    return
  }

  const trackingEnabled = syncAgentHookCompletionNotificationSettings()

  let entry = coordinatorsByPaneKey.get(paneKey)
  if (!entry || entry.worktreeId !== worktreeId) {
    entry?.coordinator.dispose()
    entry = {
      worktreeId,
      coordinator: createCoordinator(paneKey, worktreeId)
    }
    coordinatorsByPaneKey.set(paneKey, entry)
    if (requireFreshWorkingForNewTrackingCoordinators) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  // Why: notification preferences may suppress alerts, but accepted hooks must
  // still release pane-owned cursor/cache effects after the quiet window.
  if (payload.state === 'working' && trackingEnabled) {
    paneKeysRequiringFreshWorking.delete(paneKey)
  }
  entry.coordinator.observeHookStatus(payload)
}

export function resetAgentHookCompletionNotificationCoordinators(): void {
  for (const entry of coordinatorsByPaneKey.values()) {
    entry.coordinator.dispose()
  }
  coordinatorsByPaneKey.clear()
  paneKeysRequiringFreshWorking.clear()
  lastPrunedLivenessSnapshot = null
  wasAgentTaskCompleteTrackingEnabled = isAgentTaskCompleteTrackingEnabled()
  requireFreshWorkingForNewTrackingCoordinators = !wasAgentTaskCompleteTrackingEnabled
}

export function _getAgentHookCompletionNotificationCoordinatorCountForTest(): number {
  return coordinatorsByPaneKey.size
}
