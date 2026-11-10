import {
  buildTabIndex,
  paneIsPlaced,
  paneCanReceiveHookCompletion,
  type PaneCoordinatorLivenessSnapshot
} from './agent-hook-completion-pane-lifetime'
import { useAppStore } from '@/store'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion/agent-completion-coordinator'
import type {
  AgentCompletionCoordinator,
  AgentCompletionStatusSnapshot
} from '@/components/terminal-pane/agent-completion/agent-completion-coordinator-types'
import type { TerminalProcessInspection as RuntimeTerminalProcessInspection } from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { dispatchTerminalNotification } from '../components/terminal-pane/notifications/dispatch-terminal-notification'
import { getPtyIdForPaneKey } from './pane-key-pty-id'
import { dispatchAgentHookTerminalLifecycle } from '@/components/terminal-pane/agent-completion/agent-hook-terminal-lifecycle'
import { isAgentTaskCompleteTrackingEnabledFromState as isAgentHookCompletionTrackingEnabled } from '../components/terminal-pane/notifications/agent-task-complete-policy'
import {
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
  ptyId: string | null
  coordinator: AgentCompletionCoordinator
}

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

function pruneClosedPaneCoordinators(): void {
  // Module-scoped coordinators outlive panes unless close/sleep liveness changes prune them.
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
    if (!paneIsPlaced(paneKey, tabIndex)) {
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
  // Title/status writes cannot invalidate coordinator liveness; avoid pruning on that high-rate path.
  if (!shouldSyncAgentHookCompletionForStoreUpdate(current, previous)) {
    return false
  }
  if (wasAgentTaskCompleteTrackingEnabled === undefined) {
    syncAgentTaskCompleteTrackingEnabled(isAgentHookCompletionTrackingEnabled(previous))
  }
  syncAgentHookCompletionNotificationSettings()
  return true
}

function completionPtyId(paneKey: string): string | null {
  return getPtyIdForPaneKey(paneKey) ?? coordinatorsByPaneKey.get(paneKey)?.ptyId ?? null
}

function hookLaneDispatchEnabled(paneKey: string): boolean {
  return isAgentTaskCompleteTrackingEnabled() && !paneKeysRequiringFreshWorking.has(paneKey)
}

function hookLaneOwnsTurnEnd(paneKey: string, snapshot: AgentCompletionStatusSnapshot): boolean {
  return hookTurnEndEvidence(completionPtyId(paneKey), snapshot) === 'identified'
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
          (snapshot.fromHistory === true || hookLaneOwnsTurnEnd(paneKey, snapshot)),
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
      // Native settings call this task complete, but snapshot state must label the alert needs input.
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        agentStatusSnapshot: meta.agentStatus
      })
    },
    isLive: () => paneIsPlaced(paneKey)
  })
}

export function observeAgentHookCompletionForNotification({
  paneKey,
  worktreeId,
  payload,
  seedOnly,
  fromHistory
}: {
  paneKey: string
  worktreeId: string
  payload: AgentCompletionStatusSnapshot
  seedOnly?: boolean
  fromHistory?: true
}): void {
  // The canonical row already remembers passive history; do not replay it into the live completion lane.
  if (seedOnly === true && fromHistory) {
    return
  }
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
      ptyId: getPtyIdForPaneKey(paneKey),
      coordinator: createCoordinator(paneKey, worktreeId)
    }
    coordinatorsByPaneKey.set(paneKey, entry)
    if (requireFreshWorkingForNewTrackingCoordinators) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  entry.ptyId = getPtyIdForPaneKey(paneKey) ?? entry.ptyId
  // Suppressed alerts still require accepted hooks to release pane-owned cursor/cache effects after quiet time.
  if (payload.state === 'working' && payload.turnCompletedAt === undefined && trackingEnabled) {
    paneKeysRequiringFreshWorking.delete(paneKey)
  }
  // Why: on a legacy pane the host's end facts must not change main's done identity or replay guard.
  const { turnEndedAt: _turnEndedAt, turnEndDisposition: _disposition, ...legacyPayload } = payload
  const observed =
    !fromHistory && hookTurnEndEvidence(completionPtyId(paneKey), payload) === 'legacy'
      ? legacyPayload
      : fromHistory
        ? { ...payload, fromHistory }
        : payload
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
