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
import { getPtyIdForPaneKey } from './pane-key-pty-id'
import { dispatchAgentHookTerminalLifecycle } from '@/components/terminal-pane/agent-hook-terminal-lifecycle'
import {
  isAgentHookCompletionTrackingEnabled,
  shouldSyncAgentHookCompletionForStoreUpdate,
  type AgentHookCompletionStoreSnapshot
} from './agent-hook-completion-store-sync'
import { hookTurnEndEvidence } from './agent-hook-turn-end-capability'
import {
  discardHookLaneCompletionRequests,
  submitHookLaneCompletion
} from './agent-hook-completion-revision-hold'

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
let wasAgentTaskCompleteTrackingEnabled: boolean | undefined
let requireFreshWorkingForNewTrackingCoordinators = false
let lastPrunedLivenessSnapshot: PaneCoordinatorLivenessSnapshot | null = null

function disposeCoordinatorForPaneKey(paneKey: string): void {
  coordinatorsByPaneKey.get(paneKey)?.coordinator.dispose()
  coordinatorsByPaneKey.delete(paneKey)
  discardHookLaneCompletionRequests(paneKey)
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

function isAgentTaskCompleteTrackingEnabled(): boolean {
  return isAgentHookCompletionTrackingEnabled(useAppStore.getState())
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
  // Why: Zustand also publishes high-rate title/status writes that cannot make
  // module-scoped completion coordinators stale.
  if (!shouldSyncAgentHookCompletionForStoreUpdate(current, previous)) {
    return false
  }
  if (wasAgentTaskCompleteTrackingEnabled === undefined) {
    syncAgentTaskCompleteTrackingEnabled(isAgentHookCompletionTrackingEnabled(previous))
  }
  syncAgentHookCompletionNotificationSettings()
  return true
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

function hookLaneDispatchEnabled(paneKey: string): boolean {
  return isAgentTaskCompleteTrackingEnabled() && !paneKeysRequiringFreshWorking.has(paneKey)
}

function hookLaneOwnsTurnEnd(paneKey: string, snapshot: AgentCompletionStatusSnapshot): boolean {
  return hookTurnEndEvidence(getPtyIdForPaneKey(paneKey), snapshot) === 'identified'
}

function createCoordinator(paneKey: string, worktreeId: string): AgentCompletionCoordinator {
  return createAgentCompletionCoordinator({
    paneKey,
    statusLane: 'hook',
    getPtyId: () => getPtyIdForPaneKey(paneKey),
    usesHookTurnEnds: (snapshot) => hookLaneOwnsTurnEnd(paneKey, snapshot),
    inspectProcess: async (): Promise<RuntimeTerminalProcessInspection> => ({
      foregroundProcess: null,
      hasChildProcesses: false
    }),
    dispatchHookLifecycle: (payload) => dispatchAgentHookTerminalLifecycle(paneKey, payload),
    dispatchCompletion: (title, meta) => {
      if (!hookLaneDispatchEnabled(paneKey)) {
        return
      }
      const snapshot = meta?.agentStatus
      submitHookLaneCompletion(paneKey, snapshot, {
        keepsAuthority: () =>
          hookLaneDispatchEnabled(paneKey) &&
          coordinatorsByPaneKey.has(paneKey) &&
          snapshot !== undefined &&
          hookLaneOwnsTurnEnd(paneKey, snapshot),
        submit: (onDispatchResult) =>
          dispatchTerminalNotification(worktreeId, {
            source: 'agent-task-complete',
            terminalTitle: title,
            paneKey,
            ...(snapshot ? { agentStatusSnapshot: snapshot } : {}),
            onDispatchResult
          })
      })
    },
    dispatchAttention: (title, meta) => {
      if (!hookLaneDispatchEnabled(paneKey)) {
        return
      }
      // Why: native notification settings still label this channel as "agent
      // task complete"; the snapshot state makes the banner read "needs input".
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        agentStatusSnapshot: meta.agentStatus
      })
    },
    isLive: () => paneCanReceiveHookCompletion(paneKey)
  })
}

export function observeAgentHookCompletionForNotification({
  paneKey,
  worktreeId,
  payload,
  seedOnly
}: {
  paneKey: string
  worktreeId: string
  payload: AgentCompletionStatusSnapshot
  seedOnly?: boolean
}): void {
  // Why: replay seeds already passed indexed snapshot ownership; re-resolving every row makes startup batches quadratic.
  if (seedOnly !== true) {
    pruneClosedPaneCoordinators()
    if (!paneCanReceiveHookCompletion(paneKey)) {
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
  if (!entry || entry.worktreeId !== worktreeId) {
    entry?.coordinator.dispose()
    discardHookLaneCompletionRequests(paneKey)
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
  if (payload.state === 'working' && payload.turnCompletedAt === undefined && trackingEnabled) {
    paneKeysRequiringFreshWorking.delete(paneKey)
  }
  // Why: on a legacy pane the host's end facts must not change main's done identity or replay guard.
  const { turnEndedAt: _turnEndedAt, turnEndDisposition: _disposition, ...legacyPayload } = payload
  const observed =
    hookTurnEndEvidence(getPtyIdForPaneKey(paneKey), payload) === 'legacy' ? legacyPayload : payload
  if (seedOnly === true) {
    entry.coordinator.seedHookStatus(observed)
  } else {
    entry.coordinator.observeHookStatus(observed)
  }
}

// Why: asked of the lane itself so title lanes defer only where it would announce: live, agent evidence, not re-arming.
export function hookLaneCanAnnouncePaneTurnEnd(paneKey: string): boolean {
  const coordinator = coordinatorsByPaneKey.get(paneKey)?.coordinator
  return coordinator?.canAnnounceCompletion() === true && hookLaneDispatchEnabled(paneKey)
}

export function hasPendingHookLaneCompletion(paneKey: string, ptyId: string | null): boolean {
  return (
    coordinatorsByPaneKey.get(paneKey)?.coordinator.hasPendingHookDoneCompletion() === true &&
    hookTurnEndEvidence(ptyId, useAppStore.getState().agentStatusByPaneKey[paneKey]) ===
      'identified'
  )
}

export function resetAgentHookCompletionNotificationCoordinators(): void {
  for (const [paneKey, entry] of coordinatorsByPaneKey) {
    entry.coordinator.dispose()
    discardHookLaneCompletionRequests(paneKey)
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
