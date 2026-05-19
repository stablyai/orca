import { useAppStore } from '@/store'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { createAgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator'
import type { AgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion-coordinator-types'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { dispatchTerminalNotification } from '@/components/terminal-pane/use-notification-dispatch'

type CoordinatorEntry = {
  worktreeId: string
  coordinator: AgentCompletionCoordinator
}

const coordinatorsByPaneKey = new Map<string, CoordinatorEntry>()
const paneKeysRequiringFreshWorking = new Set<string>()
let wasAgentTaskCompleteNotificationEnabled = isAgentTaskCompleteNotificationEnabled()
let requireFreshWorkingForNewCoordinators = !wasAgentTaskCompleteNotificationEnabled

function isAgentTaskCompleteNotificationEnabled(): boolean {
  const notifications = useAppStore.getState().settings?.notifications
  return notifications?.enabled !== false && notifications?.agentTaskComplete !== false
}

export function syncAgentHookCompletionNotificationSettings(): boolean {
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
  return useAppStore.getState().ptyIdsByTabId?.[parsed.tabId]?.[0] ?? null
}

function paneHasLivePty(paneKey: string): boolean {
  return getPtyIdForPaneKey(paneKey) !== null
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
    dispatchCompletion: (title) => {
      dispatchTerminalNotification(worktreeId, {
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey
      })
    },
    isLive: () => paneHasLivePty(paneKey)
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
  if (!paneHasLivePty(paneKey)) {
    coordinatorsByPaneKey.get(paneKey)?.coordinator.dispose()
    coordinatorsByPaneKey.delete(paneKey)
    paneKeysRequiringFreshWorking.delete(paneKey)
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
