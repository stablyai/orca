import type { AgentProviderSessionMetadata } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  isAiVaultTitleAgent,
  sameAiVaultSessionTitle
} from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { collectAiVaultTitleRequests } from './ai-vault-tab-title-requests'
import { placedPanesEqual, titleRelevant } from './ai-vault-tab-title-placement-inputs'
import { worktreeOwnerRowsTokenOf } from '../../../workspace/ownership/worktree-owner-rows-token'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

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

function relevantRecordEqual<T extends object>(
  current: Record<string, T>,
  previous: Record<string, T>,
  relevant: (entry: T) => boolean,
  equal: (current: T, previous: T) => boolean
): boolean {
  if (current === previous) {
    return true
  }
  const changes = readRecordChanges(current, previous)
  if (changes?.kind === 'addressed') {
    for (const key of changes.keys) {
      const left = current[key]
      const right = previous[key]
      if (left && relevant(left)) {
        if (!right || !relevant(right) || !equal(left, right)) {
          return false
        }
      } else if (right && relevant(right)) {
        return false
      }
    }
    return true
  }
  const before = Object.entries(previous).filter(([, entry]) => relevant(entry))
  let index = 0
  for (const [key, entry] of Object.entries(current)) {
    if (!relevant(entry)) {
      continue
    }
    const prior = before[index++]
    if (!prior || prior[0] !== key || !equal(entry, prior[1])) {
      return false
    }
  }
  return index === before.length
}

function agentRecordsEqual(current: AppState, previous: AppState): boolean {
  const statusEqual =
    current.agentStatusByPaneKey.sharesOwner(previous.agentStatusByPaneKey) &&
    current.agentStatusByPaneKey.titleRevision === previous.agentStatusByPaneKey.titleRevision
  if (!statusEqual) {
    return false
  }

  const relevantSleeping = (entry: AppState['sleepingAgentSessionsByPaneKey'][string]): boolean =>
    isAiVaultTitleAgent(entry.agent) && Boolean(entry.providerSession.id)
  const sleepingEqual = relevantRecordEqual(
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
  return (
    sleepingEqual &&
    relevantRecordEqual(
      current.agentConversationsByPaneKey ?? {},
      previous.agentConversationsByPaneKey ?? {},
      titleRelevant,
      (left, right) =>
        left.agent === right.agent &&
        left.paneKey === right.paneKey &&
        left.worktreeId === right.worktreeId &&
        left.executionHostId === right.executionHostId &&
        left.connectionId === right.connectionId &&
        providerSessionEqual(left.providerSession, right.providerSession)
    )
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
        left.sessionTitleFromHost !== right.sessionTitleFromHost ||
        !sameAiVaultSessionTitle(left.aiVaultTitle, right.aiVaultTitle)
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

type RequestWorktreeIdsInputs = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'agentConversationsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>
let cachedRequestWorktreeIds: { inputs: RequestWorktreeIdsInputs; worktreeIds: string[] } | null =
  null

function requestInputsMatch(inputs: RequestWorktreeIdsInputs, state: AppState): boolean {
  return (
    inputs.agentStatusByPaneKey.sharesOwner(state.agentStatusByPaneKey) &&
    inputs.agentStatusByPaneKey.titleRevision === state.agentStatusByPaneKey.titleRevision &&
    inputs.agentConversationsByPaneKey === state.agentConversationsByPaneKey &&
    inputs.sleepingAgentSessionsByPaneKey === state.sleepingAgentSessionsByPaneKey &&
    inputs.tabsByWorktree === state.tabsByWorktree &&
    inputs.terminalLayoutsByTabId === state.terminalLayoutsByTabId
  )
}

// Request membership reads only these maps, so owner-only updates reuse it instead of re-collecting every tab.
function requestWorktreeIds(state: AppState): string[] {
  const cached = cachedRequestWorktreeIds
  if (cached && requestInputsMatch(cached.inputs, state)) {
    return cached.worktreeIds
  }
  const worktreeIds = [
    ...new Set(collectAiVaultTitleRequests(state).map((request) => request.worktreeId))
  ]
  cachedRequestWorktreeIds = {
    inputs: {
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      agentConversationsByPaneKey: state.agentConversationsByPaneKey,
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId
    },
    worktreeIds
  }
  return worktreeIds
}

function requestOwnersEqual(current: AppState, previous: AppState): boolean {
  // Previous first, so the single cache entry ends on current: the next update's previous.
  const worktreeIds = new Set([...requestWorktreeIds(previous), ...requestWorktreeIds(current)])
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
  const changed = syncInputsChanged(current, previous)
  // Why: later updates only move forward from current, so a snapshot it replaced can never hit again;
  // keeping it would pin closed tabs' status text and scrollback until the next owner change.
  if (cachedRequestWorktreeIds && !requestInputsMatch(cachedRequestWorktreeIds.inputs, current)) {
    cachedRequestWorktreeIds = null
  }
  return changed
}

function syncInputsChanged(current: AppState, previous: AppState): boolean {
  const agentRecordsChanged =
    current.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    current.agentConversationsByPaneKey !== previous.agentConversationsByPaneKey ||
    current.sleepingAgentSessionsByPaneKey !== previous.sleepingAgentSessionsByPaneKey
  if (agentRecordsChanged && !agentRecordsEqual(current, previous)) {
    return true
  }
  if (current.tabsByWorktree !== previous.tabsByWorktree && !terminalTabsEqual(current, previous)) {
    return true
  }
  if (
    current.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId &&
    (!activePanesEqual(current, previous) || !placedPanesEqual(current, previous))
  ) {
    return true
  }

  const ownerInputsChanged =
    current.repos !== previous.repos ||
    worktreeOwnerRowsTokenOf(selectWorktreesByRepo(current)) !==
      worktreeOwnerRowsTokenOf(selectWorktreesByRepo(previous)) ||
    selectDetectedWorktreesByRepo(current) !== selectDetectedWorktreesByRepo(previous) ||
    selectFolderWorkspaces(current) !== selectFolderWorkspaces(previous) ||
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
