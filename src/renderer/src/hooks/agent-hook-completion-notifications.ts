import { useAppStore } from '@/store'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator'
import type {
  AgentCompletionCoordinator,
  AgentCompletionStatusSnapshot
} from '@/components/terminal-pane/agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import { createCodexAutoApprovalHookCompletionSuppressor } from '@/components/terminal-pane/codex-auto-approval-notification-suppression'
import { dispatchAgentHookTerminalLifecycle } from '@/components/terminal-pane/agent-hook-terminal-lifecycle'
import {
  isAgentHookCompletionTrackingEnabled,
  shouldSyncAgentHookCompletionForStoreUpdate,
  type AgentHookCompletionStoreSnapshot
} from './agent-hook-completion-store-sync'
import {
  buildAgentHookNotificationTabIndex,
  getPtyIdForAgentHookPane,
  paneCanReceiveAgentHookNotification
} from './agent-hook-notification-pane-liveness'

type CoordinatorEntry = {
  worktreeId: string
  coordinator: AgentCompletionCoordinator
  remotePaneEvidence?: AgentCompletionStatusSnapshot['remotePaneEvidence']
}

type StoreSnapshot = ReturnType<typeof useAppStore.getState>
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
  paneKeysRequiringFreshWorking.delete(paneKey)
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
  const tabIndex = buildAgentHookNotificationTabIndex(livenessSnapshot.tabsByWorktree)
  for (const [paneKey, entry] of coordinatorsByPaneKey) {
    if (!paneCanReceiveAgentHookNotification(paneKey, tabIndex, entry.remotePaneEvidence)) {
      disposeCoordinatorForPaneKey(paneKey)
    }
  }
  for (const paneKey of paneKeysRequiringFreshWorking) {
    if (
      !paneCanReceiveAgentHookNotification(
        paneKey,
        tabIndex,
        coordinatorsByPaneKey.get(paneKey)?.remotePaneEvidence
      )
    ) {
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

function createCoordinator(paneKey: string, worktreeId: string): AgentCompletionCoordinator {
  return createAgentCompletionCoordinator({
    paneKey,
    statusLane: 'hook',
    getPtyId: () => getPtyIdForAgentHookPane(paneKey),
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
        ...(meta?.agentStatus?.attentionRequired ? { attentionRequired: true } : {}),
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
        ...(meta.agentStatus.attentionRequired ? { attentionRequired: true } : {}),
        agentStatusSnapshot: meta.agentStatus
      })
    },
    isLive: (agentStatus) =>
      paneCanReceiveAgentHookNotification(paneKey, undefined, agentStatus?.remotePaneEvidence),
    shouldSuppressHookCompletion: createCodexAutoApprovalHookCompletionSuppressor(paneKey)
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
    if (!paneCanReceiveAgentHookNotification(paneKey, undefined, payload.remotePaneEvidence)) {
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
    (payload.remotePaneEvidence !== undefined &&
      entry.remotePaneEvidence?.paneIncarnation !== payload.remotePaneEvidence.paneIncarnation)
  ) {
    entry?.coordinator.dispose()
    entry = {
      worktreeId,
      coordinator: createCoordinator(paneKey, worktreeId),
      ...(payload.remotePaneEvidence ? { remotePaneEvidence: payload.remotePaneEvidence } : {})
    }
    coordinatorsByPaneKey.set(paneKey, entry)
    if (requireFreshWorkingForNewTrackingCoordinators) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  entry.remotePaneEvidence = payload.remotePaneEvidence
  // Why: notification preferences may suppress alerts, but accepted hooks must
  // still release pane-owned cursor/cache effects after the quiet window.
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
