import type {
  SleepingAgentSessionRecord,
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AppState } from '../../types'
import type { localAgentConversationAcceptance } from './agent-conversation-acceptance'
import type {
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming
} from './agent-status-contract'

export type AgentStatusLiveEntryBuild = {
  entry: AgentStatusEntry
  conversationSource: ReturnType<typeof localAgentConversationAcceptance>['source']
  existing: AgentStatusEntry | undefined
  existingSleepingRecord: SleepingAgentSessionRecord | undefined
  liveRecoveryRecord: SleepingAgentSessionRecord | null
  launchConfigSource: SleepingAgentLaunchConfig | undefined
  registryEntry: AppState['agentLaunchConfigByPaneKey'][string] | undefined
  registryMatched: boolean
  providerSession: AgentProviderSessionMetadata | undefined
  providerSessionChanged: boolean
  retainsResumableRecoveryIdentity: boolean
  migrationUnsupported: {
    next: Record<string, MigrationUnsupportedPtyEntry>
    changed: boolean
  }
  commandCodeNewTurn: boolean
  sortRelevantChange: boolean
  aggregateRelevantChange: boolean
  completionRefreshWorktreeId: string | null
  boundaryResolved: boolean
}

export type AgentStatusLiveEntryRejection = {
  entry: null
  reason: 'stale' | 'suppressed-inherited-terminal'
}

export type AgentStatusLiveEntryArgs = {
  state: AppState
  paneKey: string
  payload: AgentStatusPayload
  terminalTitle?: string
  timing?: AgentStatusTiming
  routing?: AgentStatusRouting
  metadata?: AgentStatusMetadata
  updatedAt: number
}
