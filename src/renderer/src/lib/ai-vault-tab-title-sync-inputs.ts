import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { isAiVaultTitleAgent } from '../../../shared/ai-vault-session-title'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { collectAiVaultTitleRequests } from './ai-vault-tab-title-requests'

function providerSessionEqual(
  left: AgentProviderSessionMetadata | undefined,
  right: AgentProviderSessionMetadata | undefined
): boolean {
  return (
    left?.key === right?.key &&
    left?.id === right?.id &&
    left?.transcriptPath === right?.transcriptPath
  )
}

function relevantRecordEqual<T>(
  current: Record<string, T>,
  previous: Record<string, T>,
  relevant: (entry: T) => boolean,
  equal: (current: T, previous: T) => boolean
): boolean {
  let currentCount = 0
  let previousCount = 0
  for (const [key, entry] of Object.entries(current)) {
    if (!relevant(entry)) {
      continue
    }
    currentCount++
    const previousEntry = previous[key]
    if (!previousEntry || !relevant(previousEntry) || !equal(entry, previousEntry)) {
      return false
    }
  }
  for (const entry of Object.values(previous)) {
    if (relevant(entry)) {
      previousCount++
    }
  }
  return currentCount === previousCount
}

function agentRecordsEqual(current: AppState, previous: AppState): boolean {
  const relevantStatus = (entry: AppState['agentStatusByPaneKey'][string]): boolean =>
    isAiVaultTitleAgent(entry.agentType) && Boolean(entry.providerSession?.id)
  const statusEqual = relevantRecordEqual(
    current.agentStatusByPaneKey,
    previous.agentStatusByPaneKey,
    relevantStatus,
    (left, right) =>
      left.agentType === right.agentType &&
      left.paneKey === right.paneKey &&
      left.tabId === right.tabId &&
      left.worktreeId === right.worktreeId &&
      providerSessionEqual(left.providerSession, right.providerSession)
  )
  if (!statusEqual) {
    return false
  }

  const relevantRetained = (entry: AppState['retainedAgentsByPaneKey'][string]): boolean =>
    isAiVaultTitleAgent(entry.agentType) && Boolean(entry.entry.providerSession?.id)
  const retainedEqual = relevantRecordEqual(
    current.retainedAgentsByPaneKey,
    previous.retainedAgentsByPaneKey,
    relevantRetained,
    (left, right) =>
      left.agentType === right.agentType &&
      left.worktreeId === right.worktreeId &&
      left.entry.paneKey === right.entry.paneKey &&
      left.entry.tabId === right.entry.tabId &&
      providerSessionEqual(left.entry.providerSession, right.entry.providerSession)
  )
  if (!retainedEqual) {
    return false
  }

  const relevantSleeping = (entry: AppState['sleepingAgentSessionsByPaneKey'][string]): boolean =>
    isAiVaultTitleAgent(entry.agent) && Boolean(entry.providerSession.id)
  return relevantRecordEqual(
    current.sleepingAgentSessionsByPaneKey,
    previous.sleepingAgentSessionsByPaneKey,
    relevantSleeping,
    (left, right) =>
      left.agent === right.agent &&
      left.paneKey === right.paneKey &&
      left.tabId === right.tabId &&
      left.worktreeId === right.worktreeId &&
      providerSessionEqual(left.providerSession, right.providerSession)
  )
}

function titleEqual(
  left: TerminalTab['aiVaultTitle'],
  right: TerminalTab['aiVaultTitle']
): boolean {
  return (
    left?.agent === right?.agent &&
    left?.sessionId === right?.sessionId &&
    left?.title === right?.title
  )
}

function terminalTabsEqual(current: AppState, previous: AppState): boolean {
  const currentKeys = Object.keys(current.tabsByWorktree)
  const previousKeys = Object.keys(previous.tabsByWorktree)
  if (currentKeys.length !== previousKeys.length) {
    return false
  }
  for (const worktreeId of currentKeys) {
    const currentTabs = current.tabsByWorktree[worktreeId]
    const previousTabs = previous.tabsByWorktree[worktreeId]
    if (!previousTabs || currentTabs.length !== previousTabs.length) {
      return false
    }
    for (let index = 0; index < currentTabs.length; index++) {
      const left = currentTabs[index]
      const right = previousTabs[index]
      if (
        left.id !== right.id ||
        left.worktreeId !== right.worktreeId ||
        !titleEqual(left.aiVaultTitle, right.aiVaultTitle)
      ) {
        return false
      }
    }
  }
  return true
}

function activePanesEqual(current: AppState, previous: AppState): boolean {
  const currentKeys = Object.keys(current.terminalLayoutsByTabId)
  const previousKeys = Object.keys(previous.terminalLayoutsByTabId)
  if (currentKeys.length !== previousKeys.length) {
    return false
  }
  return currentKeys.every(
    (tabId) =>
      current.terminalLayoutsByTabId[tabId]?.activeLeafId ===
      previous.terminalLayoutsByTabId[tabId]?.activeLeafId
  )
}

function requestOwnersEqual(current: AppState, previous: AppState): boolean {
  const worktreeIds = new Set([
    ...collectAiVaultTitleRequests(current).map((request) => request.worktreeId),
    ...collectAiVaultTitleRequests(previous).map((request) => request.worktreeId)
  ])
  for (const worktreeId of worktreeIds) {
    const currentHost = getExecutionHostIdForWorktree(current, worktreeId)
    const previousHost = getExecutionHostIdForWorktree(previous, worktreeId)
    if (currentHost !== previousHost) {
      return false
    }
  }
  return true
}

export function aiVaultTitleSyncInputsChanged(current: AppState, previous: AppState): boolean {
  const agentRecordsChanged =
    current.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    current.retainedAgentsByPaneKey !== previous.retainedAgentsByPaneKey ||
    current.sleepingAgentSessionsByPaneKey !== previous.sleepingAgentSessionsByPaneKey
  if (agentRecordsChanged && !agentRecordsEqual(current, previous)) {
    return true
  }
  if (current.tabsByWorktree !== previous.tabsByWorktree && !terminalTabsEqual(current, previous)) {
    return true
  }
  if (
    current.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId &&
    !activePanesEqual(current, previous)
  ) {
    return true
  }

  const ownerInputsChanged =
    current.repos !== previous.repos ||
    current.worktreesByRepo !== previous.worktreesByRepo ||
    current.detectedWorktreesByRepo !== previous.detectedWorktreesByRepo ||
    current.folderWorkspaces !== previous.folderWorkspaces ||
    current.projectGroups !== previous.projectGroups ||
    current.settings !== previous.settings ||
    current.activeWorktreeId !== previous.activeWorktreeId ||
    current.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
    current.restoredRuntimeHostIdByWorkspaceSessionKey !==
      previous.restoredRuntimeHostIdByWorkspaceSessionKey ||
    current.runtimeEnvironments !== previous.runtimeEnvironments ||
    current.runtimeEnvironmentCatalogHydrated !== previous.runtimeEnvironmentCatalogHydrated ||
    current.removedRuntimeEnvironmentIds !== previous.removedRuntimeEnvironmentIds
  return ownerInputsChanged && !requestOwnersEqual(current, previous)
}
