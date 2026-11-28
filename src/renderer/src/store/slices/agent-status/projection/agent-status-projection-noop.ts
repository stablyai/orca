import { remoteRowContextsFor } from '@/runtime/agent-orchestration/remote-row-orchestration'
import {
  movedAgentSenderChannels,
  samePublishingHosts
} from '@/runtime/native-chat/agent-senders/agent-sender-index'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { AppState } from '../../../types'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../../workspaces/catalog/workspace-record-fields'
import type { AgentStatusChange } from '../contracts/agent-status-contract'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

/** True when a store write touched no agent-status, tab, orchestration, sender, or dashboard-owner input. */
export function isAgentStatusProjectionNoop(
  data: AgentStatusProjectionState,
  state: AppState,
  changes: readonly AgentStatusChange[],
  refreshKeys: readonly string[],
  fullResync: boolean
): boolean {
  const previous = data.inputs
  if (
    !previous ||
    changes.length > 0 ||
    refreshKeys.length > 0 ||
    fullResync ||
    data.touchedWorktrees.size > 0
  ) {
    return false
  }
  if (
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
    state.runtimePaneTitlesByTabId !== previous.runtimePaneTitlesByTabId ||
    state.ptyIdsByTabId !== previous.ptyIdsByTabId ||
    state.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey ||
    state.runtimeAgentOrchestrationByPaneKey !== previous.runtimeAgentOrchestrationByPaneKey ||
    state.migrationUnsupportedByPtyId !== previous.migrationUnsupportedByPtyId ||
    state.agentSenderPublicationsByHost !== previous.agentSenderPublicationsByHost ||
    state.acknowledgedAgentsByPaneKey !== previous.acknowledgedAgentsByPaneKey ||
    state.repos !== previous.repos ||
    selectWorktreesByRepo(state) !== selectWorktreesByRepo(previous) ||
    selectFolderWorkspaces(state) !== selectFolderWorkspaces(previous) ||
    state.projectGroups !== previous.projectGroups
  ) {
    return false
  }
  for (const key of state.agentStatusByPaneKey.stagedKeys()) {
    if (state.agentStatusByPaneKey.wasMoved(key)) {
      return false
    }
  }
  if (remoteRowContextsFor(state) !== data.remoteRows) {
    return false
  }
  const ownerInputs = structuredAgentSessionOwnerInputs(state)
  const oldOwnerInputs = structuredAgentSessionOwnerInputs(previous)
  if (ownerInputs.length !== oldOwnerInputs.length) {
    return false
  }
  for (let index = 0; index < ownerInputs.length; index++) {
    if (ownerInputs[index] !== oldOwnerInputs[index]) {
      return false
    }
  }
  return true
}

export function detectProjectionSenderChanges(
  data: AgentStatusProjectionState,
  previous: AppState | null,
  state: AppState,
  changes: readonly AgentStatusChange[]
): { senderLocationsChanged: boolean; movedSenders: readonly string[] } {
  const ownerInputs = structuredAgentSessionOwnerInputs(state)
  const oldOwnerInputs = previous ? structuredAgentSessionOwnerInputs(previous) : []
  const sendersChanged =
    previous?.agentSenderPublicationsByHost !== state.agentSenderPublicationsByHost
  const senderLocationsChanged =
    !previous ||
    (sendersChanged && !samePublishingHosts(previous, state)) ||
    previous.tabsByWorktree !== state.tabsByWorktree ||
    previous.unifiedTabsByWorktree !== state.unifiedTabsByWorktree ||
    ownerInputs.some((value, index) => value !== oldOwnerInputs[index]) ||
    changes.some(
      (change) =>
        change.previous?.terminalHandle !== change.current?.terminalHandle ||
        (Boolean(change.previous?.terminalHandle || change.current?.terminalHandle) &&
          change.previous?.worktreeId !== change.current?.worktreeId)
    )
  // Only a publication moved: notify the senders whose answer it moved, not every card.
  const movedSenders =
    previous && sendersChanged && !senderLocationsChanged
      ? movedAgentSenderChannels(previous, state, data.listeners.keys())
      : []
  return { senderLocationsChanged, movedSenders }
}
