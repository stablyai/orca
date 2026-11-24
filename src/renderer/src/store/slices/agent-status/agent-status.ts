import { acceptedAgentStatuses } from './status-ownership/accepted-agent-statuses'
import { agentSenderPublicationPatch } from '@/runtime/native-chat/agent-senders/agent-sender-publication-patch'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { AgentStatusSlice } from './contracts/agent-status-slice-contract'
import { createAgentStatusRuntime } from './status-ownership/agent-status-runtime'
import { createAgentStatusAuthorityActions } from './pane-authority/agent-status-authority-actions'
import { createAgentStatusCleanupActions } from './retirement/agent-status-cleanup-actions'
import { createAgentStatusDropActions } from './retirement/agent-status-drop-actions'
import { createAgentStatusWorktreeDropActions } from './retirement/agent-status-worktree-drop-actions'
import { createAgentStatusLaunchActions } from './launch-config/agent-status-launch-actions'
import { createAgentStatusLiveActions } from './live-status/agent-status-live-actions'
import { createAgentStatusOrchestrationActions } from './orchestration/agent-status-orchestration-actions'
import { createAgentStatusProviderSessionActions } from './live-status/agent-status-provider-session-actions'
import { createAgentStatusProgramStatusActions } from './live-status/agent-status-program-status-actions'
import { createAgentStatusRecoveryActions } from './sleep-recovery/agent-status-recovery-actions'

// Keep this path as the public contract for callers while implementation details live beside it.

import './sleep-recovery/agent-status-recovery-collection'
import './sleep-recovery/agent-status-sleeping-records'
import './retirement/agent-status-drop-reducer'
import './live-status/agent-status-capacity-eviction'
import './pane-authority/agent-status-pane-keyed-records'

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  storeSet,
  storeGet
) => {
  let composedActions:
    | Pick<
        AgentStatusSlice,
        'setAgentStatus' | 'recordAgentProviderSession' | 'setAgentProgramStatus'
      >
    | undefined
  const runtime = createAgentStatusRuntime(storeSet, storeGet, () => {
    if (!composedActions) {
      throw new Error('agent-status actions are not initialized')
    }
    return composedActions
  })
  const actions = {
    ...createAgentStatusAuthorityActions(runtime),
    ...createAgentStatusCleanupActions(runtime),
    ...createAgentStatusDropActions(runtime),
    ...createAgentStatusWorktreeDropActions(runtime),
    ...createAgentStatusLaunchActions(runtime),
    ...createAgentStatusLiveActions(runtime),
    ...createAgentStatusOrchestrationActions(runtime),
    ...createAgentStatusProviderSessionActions(runtime),
    ...createAgentStatusProgramStatusActions(runtime),
    ...createAgentStatusRecoveryActions(runtime)
  }
  composedActions = {
    setAgentStatus: actions.setAgentStatus,
    recordAgentProviderSession: actions.recordAgentProviderSession,
    setAgentProgramStatus: actions.setAgentProgramStatus
  }
  return {
    ...actions,
    agentSenderPublicationsByHost: {},
    setAgentSenderPublication: (host, publication) =>
      storeSet((state) => {
        const patch = agentSenderPublicationPatch(state, host, '*', publication)
        return patch.agentSenderPublicationsByHost ? patch : state
      }),
    subscribeAgentStatusChanges: runtime.subscribeAgentStatusChanges,
    updateAgentStatusState: runtime.set,
    agentStatusByPaneKey: acceptedAgentStatuses(),
    agentConversationsByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    agentStatusEpoch: 0,
    transientClearedAgentStatusConnectionIds: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: {}
  }
}
