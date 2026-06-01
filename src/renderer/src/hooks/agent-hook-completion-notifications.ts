import { useAppStore } from '@/store'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator'
import type { AgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/layout-serialization'

type CoordinatorEntry = {
  worktreeId: string
  coordinator: AgentCompletionCoordinator
}

type StoreSnapshot = ReturnType<typeof useAppStore.getState>

const coordinatorsByPaneKey = new Map<string, CoordinatorEntry>()
const paneKeysRequiringFreshWorking = new Set<string>()
let wasAgentTaskCompleteNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
let requireFreshWorkingForNewCoordinators = !wasAgentTaskCompleteNotificationEnabled

function disposeCoordinatorForPaneKey(paneKey: string): void {
  coordinatorsByPaneKey.get(paneKey)?.coordinator.dispose()
  coordinatorsByPaneKey.delete(paneKey)
  paneKeysRequiringFreshWorking.delete(paneKey)
}

function pruneClosedPaneCoordinators(): void {
  // Why: hook-completion coordinators are module-scoped and may outlive a pane
  // unless liveness changes from close/sleep paths evict them here.
  for (const paneKey of coordinatorsByPaneKey.keys()) {
    if (!paneCanReceiveHookCompletion(paneKey)) {
      disposeCoordinatorForPaneKey(paneKey)
    }
  }
  for (const paneKey of paneKeysRequiringFreshWorking) {
    if (!paneCanReceiveHookCompletion(paneKey)) {
      paneKeysRequiringFreshWorking.delete(paneKey)
    }
  }
}

function isAgentTaskCompleteNotificationEnabled(): boolean {
  const notifications = useAppStore.getState().settings?.notifications
  return notifications?.enabled !== false && notifications?.agentTaskComplete !== false
}

export function syncAgentHookCompletionNotificationSettings(): boolean {
  pruneClosedPaneCoordinators()
  const enabled = isAgentTaskCompleteNotificationEnabled()
  if (!enabled || (!wasAgentTaskCompleteNotificationEnabled && enabled)) {
    requireFreshWorkingForNewCoordinators = true
    for (const [paneKey, entry] of coordinatorsByPaneKey) {
      paneKeysRequiringFreshWorking.add(paneKey)
      entry.coordinator.resetCompletionState({ requireFreshWorking: true })
    }
  }
  wasAgentTaskCompleteNotificationEnabled = enabled
  return enabled
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

function paneKeyHasUnsuppressedPtyHint(state: StoreSnapshot, paneKey: string): boolean {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return false
  }
  const tab = Object.values(state.tabsByWorktree ?? {})
    .flat()
    .find((candidate) => candidate.id === parsed.tabId)
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

function paneCanReceiveHookCompletion(paneKey: string): boolean {
  const state = useAppStore.getState()
  // Why: native hook IPC is itself a live status signal. Inactive worktrees can
  // have accepted hook updates before their renderer PTY map catches up.
  return paneKeyHasUnsuppressedPtyHint(state, paneKey) || paneHasLivePty(paneKey)
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
    dispatchCompletion: (title, meta) => {
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey,
        ...(meta?.agentStatus ? { agentStatusSnapshot: meta.agentStatus } : {})
      })
    },
    isLive: () => paneCanReceiveHookCompletion(paneKey)
  })
}

export function observeAgentHookCompletionForNotification({
  paneKey,
  worktreeId,
  payload
}: {
  paneKey: string
  worktreeId: string
  payload: ParsedAgentStatusPayload
}): void {
  pruneClosedPaneCoordinators()
  if (!paneCanReceiveHookCompletion(paneKey)) {
    return
  }

  if (!syncAgentHookCompletionNotificationSettings()) {
    paneKeysRequiringFreshWorking.add(paneKey)
    coordinatorsByPaneKey
      .get(paneKey)
      ?.coordinator.resetCompletionState({ requireFreshWorking: true })
    return
  }

  let entry = coordinatorsByPaneKey.get(paneKey)
  if (!entry || entry.worktreeId !== worktreeId) {
    entry?.coordinator.dispose()
    entry = {
      worktreeId,
      coordinator: createCoordinator(paneKey, worktreeId)
    }
    coordinatorsByPaneKey.set(paneKey, entry)
    if (requireFreshWorkingForNewCoordinators) {
      paneKeysRequiringFreshWorking.add(paneKey)
    }
  }
  if (paneKeysRequiringFreshWorking.has(paneKey)) {
    entry.coordinator.resetCompletionState({ requireFreshWorking: true })
  }

  entry.coordinator.observeHookStatus(payload)
  if (payload.state === 'working') {
    paneKeysRequiringFreshWorking.delete(paneKey)
  }
}

export function resetAgentHookCompletionNotificationCoordinators(): void {
  for (const entry of coordinatorsByPaneKey.values()) {
    entry.coordinator.dispose()
  }
  coordinatorsByPaneKey.clear()
  paneKeysRequiringFreshWorking.clear()
  wasAgentTaskCompleteNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
  requireFreshWorkingForNewCoordinators = !wasAgentTaskCompleteNotificationEnabled
}

export function _getAgentHookCompletionNotificationCoordinatorCountForTest(): number {
  return coordinatorsByPaneKey.size
}
