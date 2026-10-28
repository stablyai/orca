import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import { createAgentStatusRuntime } from './agent-status-runtime'
import { createAgentStatusAuthorityActions } from './agent-status-authority-actions'
import { createAgentStatusCleanupActions } from './agent-status-cleanup-actions'
import { createAgentStatusDropActions } from './agent-status-drop-actions'
import { createAgentStatusWorktreeDropActions } from './agent-status-worktree-drop-actions'
import { createAgentStatusLaunchActions } from './agent-status-launch-actions'
import { createAgentStatusLiveActions } from './agent-status-live-actions'
import { createAgentStatusOrchestrationActions } from './agent-status-orchestration-actions'
import { createAgentStatusProviderSessionActions } from './agent-status-provider-session-actions'
import { createAgentStatusProgramStatusActions } from './agent-status-program-status-actions'
import { createAgentStatusRecoveryActions } from './agent-status-recovery-actions'
import { createAgentStatusRetentionActions } from './agent-status-retention-actions'

// Keep this path as the public contract for callers while implementation details live beside it.

import './agent-status-recovery-collection'
import './agent-status-sleeping-records'
import './agent-status-drop-reducer'
import './agent-status-capacity-eviction'
import './agent-status-pane-keyed-records'

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
    ...createAgentStatusRecoveryActions(runtime),
    ...createAgentStatusRetentionActions(runtime)
  }
  composedActions = {
    setAgentStatus: actions.setAgentStatus,
    recordAgentProviderSession: actions.recordAgentProviderSession,
    setAgentProgramStatus: actions.setAgentProgramStatus
  }
  return {
    ...actions,
    agentStatusByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    agentStatusEpoch: 0,
    transientClearedAgentStatusConnectionIds: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    retentionSuppressedPaneKeys: {},
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: {}
  }
}
