import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type {
  AgentCompletionCoordinator,
  AgentCompletionStatusSnapshot
} from '@/components/terminal-pane/agent-completion-coordinator-types'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'
import { createAgentHookCompletionCoordinator } from './agent-hook-completion-coordinator-factory'
import {
  isAgentHookCompletionTrackingEnabled,
  shouldSyncAgentHookCompletionForStoreUpdate,
  type AgentHookCompletionStoreSnapshot
} from './agent-hook-completion-store-sync'

type CoordinatorEntry = {
  worktreeId: string
  authoritativeRemote: boolean
  coordinator: AgentCompletionCoordinator
}

type StoreSnapshot = ReturnType<typeof useAppStore.getState>
type WorktreeTab = NonNullable<StoreSnapshot['tabsByWorktree']>[string][number]
type TabIndex = ReadonlyMap<string, WorktreeTab>
type PaneCoordinatorLivenessSnapshot = Pick<
  StoreSnapshot,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'suppressedPtyExitIds'
>

const coordinatorsByPaneKey = new Map<string, CoordinatorEntry>()
const paneKeysRequiringFreshWorking = new Set<string>()
let wasAgentTaskCompleteTrackingEnabled: boolean | undefined
let requireFreshWorkingForNewTrackingCoordinators = false
let lastPrunedLivenessSnapshot: PaneCoordinatorLivenessSnapshot | null = null

function disposeCoordinatorForPaneKey(paneKey: string): void {
  coordinatorsByPaneKey.get(paneKey)?.coordinator.dispose({ clearReplayState: true })
  coordinatorsByPaneKey.delete(paneKey)
  paneKeysRequiringFreshWorking.delete(paneKey)
}

export function forgetAgentHookCompletionNotificationCoordinator(paneKey: string): void {
  disposeCoordinatorForPaneKey(paneKey)
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
  const n = useAppStore.getState().settings?.notifications
  return n?.enabled !== false && n?.agentTaskComplete !== false
}
function isTerminalAttentionEnabled(): boolean {
  return useAppStore.getState().settings?.experimentalTerminalAttention === true
}
function isAgentTaskCompleteTrackingEnabled(): boolean {
  return isAgentTaskCompleteNotificationEnabled() || isTerminalAttentionEnabled()
}
function syncAgentTaskCompleteTrackingEnabled(enabled: boolean): void {
  if (wasAgentTaskCompleteTrackingEnabled === undefined) {
    wasAgentTaskCompleteTrackingEnabled = enabled
    requireFreshWorkingForNewTrackingCoordinators = !enabled
    return
  }
  if (enabled !== wasAgentTaskCompleteTrackingEnabled) {
    requireFreshWorkingForNewTrackingCoordinators = true
    for (const paneKey of coordinatorsByPaneKey.keys()) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  wasAgentTaskCompleteTrackingEnabled = enabled
}
export function syncAgentHookCompletionNotificationSettings(): boolean {
  pruneClosedPaneCoordinators()
  const enabled = isAgentTaskCompleteTrackingEnabled()
  syncAgentTaskCompleteTrackingEnabled(enabled)
  return enabled
}
export function syncAgentHookCompletionNotificationsForStoreUpdate(
  current: AgentHookCompletionStoreSnapshot,
  previous: AgentHookCompletionStoreSnapshot
): boolean {
  if (!shouldSyncAgentHookCompletionForStoreUpdate(current, previous)) {
    return false
  }
  if (wasAgentTaskCompleteTrackingEnabled === undefined) {
    syncAgentTaskCompleteTrackingEnabled(isAgentHookCompletionTrackingEnabled(previous))
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
export function observeAgentHookCompletionForNotification({
  paneKey,
  worktreeId,
  payload,
  seedOnly,
  authoritativeRemote
}: {
  paneKey: string
  worktreeId: string
  payload: AgentCompletionStatusSnapshot
  seedOnly?: boolean
  authoritativeRemote?: boolean
}): void {
  if (seedOnly !== true) {
    pruneClosedPaneCoordinators()
    if (!authoritativeRemote && !paneCanReceiveHookCompletion(paneKey)) {
      return
    }
  }

  const trackingEnabled = isAgentTaskCompleteTrackingEnabled()
  if (seedOnly === true) {
    syncAgentTaskCompleteTrackingEnabled(trackingEnabled)
  } else {
    syncAgentHookCompletionNotificationSettings()
  }

  let entry = coordinatorsByPaneKey.get(paneKey)
  if (
    !entry ||
    entry.worktreeId !== worktreeId ||
    (authoritativeRemote === true && !entry.authoritativeRemote)
  ) {
    entry?.coordinator.dispose()
    entry = {
      worktreeId,
      authoritativeRemote: authoritativeRemote === true,
      coordinator: createAgentHookCompletionCoordinator({
        paneKey,
        worktreeId,
        authoritativeRemote: authoritativeRemote === true,
        getPtyId: () => getPtyIdForPaneKey(paneKey),
        isLive: () => authoritativeRemote === true || paneCanReceiveHookCompletion(paneKey),
        isTrackingEnabled: isAgentTaskCompleteTrackingEnabled,
        requiresFreshWorking: () => paneKeysRequiringFreshWorking.has(paneKey)
      })
    }
    coordinatorsByPaneKey.set(paneKey, entry)
    if (requireFreshWorkingForNewTrackingCoordinators) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  if (payload.state === 'working' && payload.turnCompletedAt === undefined && trackingEnabled) {
    paneKeysRequiringFreshWorking.delete(paneKey)
  }
  if (seedOnly === true) {
    entry.coordinator.seedHookStatus(payload)
  } else {
    entry.coordinator.observeHookStatus(payload)
  }
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
