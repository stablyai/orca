import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
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
import { createAgentStatusRecoveryActions } from './agent-status-recovery-actions'
import { createAgentStatusRetentionActions } from './agent-status-retention-actions'

// Keep this path as the public contract for callers while implementation details live beside it.
export type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata,
  AgentLaunchConfigStatusMetadata,
  AgentProviderSessionRecordMetadata,
  AgentProviderSessionRouting,
  AgentProviderSessionTiming,
  AgentStatusBatchTransaction,
  AgentStatusBatchUpdate,
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming,
  AgentStatusUpdate,
  AgentProviderSessionUpdate,
  AgentStatusWorktreeShutdownReason,
  AllAgentSessionCaptureMode,
  DropAgentStatusByTabPrefixOptions,
  DropAgentStatusByWorktreeOptions,
  DropHibernatedAgentPaneOptions,
  RetainedAgentEntry,
  AgentStateHistoryEntry,
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentType,
  MigrationUnsupportedPtyEntry,
  ParsedAgentStatusPayload,
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from './agent-status-contract'
export type { AgentStatusSlice } from './agent-status-slice-contract'
export {
  collectSleepingAgentSessionRecordsForWorktree,
  collectHibernatedCompletionEvidenceForWorktree
} from './agent-status-recovery-collection'
export { removeSleepingRecordsReplacedByManualWorktreeSleep } from './agent-status-sleeping-records'
export {
  buildAgentStatusTabPrefixDropPatch,
  type AgentStatusTabPrefixDropState
} from './agent-status-drop-reducer'
export { MAX_LIVE_AGENT_STATUSES } from './agent-status-capacity-eviction'
export {
  RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX
} from './agent-status-pane-keyed-records'

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  storeSet,
  storeGet
) => {
  let composedActions:
    | Pick<AgentStatusSlice, 'setAgentStatus' | 'recordAgentProviderSession'>
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
    ...createAgentStatusRecoveryActions(runtime),
    ...createAgentStatusRetentionActions(runtime)
  } as AgentStatusSlice
  composedActions = {
    setAgentStatus: actions.setAgentStatus,
    recordAgentProviderSession: actions.recordAgentProviderSession
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
