import type { AppState } from '../types'
import type {
  AgentStateHistoryEntry,
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentType,
  MigrationUnsupportedPtyEntry,
  ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { AgentStatusObservation } from '../../../../shared/agent-status-observation'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export type RetainedAgentEntry = {
  entry: AgentStatusEntry
  worktreeId: string
  /** Snapshot of the tab at retention time; kept full (not just an id) because the tab may be gone from `tabsByWorktree` by render time. */
  tab: TerminalTab
  agentType: AgentType
  startedAt: number
}

export type AgentStatusWorktreeShutdownReason =
  | 'manual-sleep'
  | 'remove-worktree'
  | 'auto-hibernate-completed-agent'

export type AllAgentSessionCaptureMode = 'periodic' | 'quit'

export type DropAgentStatusByWorktreeOptions = {
  shutdownReason?: AgentStatusWorktreeShutdownReason
  sleepingPaneKeys?: readonly string[] | ReadonlySet<string>
  retainedCompletionEvidence?: readonly RetainedAgentEntry[]
}

export type DropHibernatedAgentPaneOptions = {
  retainedCompletionEvidence?: readonly RetainedAgentEntry[]
}

export type DropAgentStatusOptions = {
  /** The pane itself is gone (pane close, stale-row teardown). Row-only dismissals leave the
   *  cleared-at cutoff and manual-unread stamp in place so a still-live pane's next hook event
   *  cannot resurrect activity the user already cleared. */
  paneRemoved?: boolean
}

export type DropAgentStatusByTabPrefixOptions = {
  worktreeId?: string
  /** Keep cleared-at cutoffs and manual-unread stamps: a mirrored-tab retraction is loss of
   *  contact, not pane death, and the host republishes the same panes on reconnect. */
  preserveActivityClearedState?: boolean
}

export type AgentLaunchConfigRegistrationMetadata = {
  agentType?: AgentType
  launchToken?: string
  tabId?: string
  leafId?: string
  terminalHandle?: string
  providerSession?: AgentProviderSessionMetadata
}

export type AgentLaunchConfigStatusMetadata = {
  paneKey: string
  agentType?: AgentType
  tabId?: string
  terminalHandle?: string
  launchToken?: string
  providerSession?: AgentProviderSessionMetadata
  existingProviderSession?: AgentProviderSessionMetadata
  providerSessionChanged?: boolean
}

export type AgentLaunchConfigRegistryEntry = {
  launchConfig: SleepingAgentLaunchConfig
  registeredAt: number
  identity: AgentLaunchConfigRegistrationMetadata
}

export type AgentStatusPayload = ParsedAgentStatusPayload & {
  orchestration?: AgentStatusOrchestrationContext
  promptInteractionKey?: string
  restoredUnconfirmed?: boolean
  /** Ingress provenance for this write (STA-4293). Read by nothing yet; a caller that omits
   *  it produces exactly the entry it produces today. See agent-status-observation.ts. */
  observation?: AgentStatusObservation
}

export type AgentStatusTiming = {
  updatedAt?: number
  /** Observation clock for staleness; see `AgentStatusEntry.evidenceObservedAt`. */
  evidenceObservedAt?: number
  stateStartedAt?: number
}

export type AgentStatusRouting = {
  tabId?: string
  worktreeId?: string
  terminalHandle?: string
  connectionId?: string | null
}

export type AgentStatusMetadata = {
  providerSession?: AgentProviderSessionMetadata
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  terminalResumeEligible?: false
}

export type AgentStatusUpdate = {
  kind?: 'status'
  paneKey: string
  payload: AgentStatusPayload
  terminalTitle?: string
  timing?: AgentStatusTiming
  routing?: AgentStatusRouting
  metadata?: AgentStatusMetadata
}

export type AgentProviderSessionTiming = { updatedAt?: number }

export type AgentProviderSessionRouting = {
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
}

export type AgentProviderSessionRecordMetadata = { launchToken?: string }

export type AgentProviderSessionUpdate = {
  kind: 'providerSession'
  paneKey: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  timing?: AgentProviderSessionTiming
  routing?: AgentProviderSessionRouting
  metadata?: AgentProviderSessionRecordMetadata
}

export type AgentStatusBatchUpdate = AgentStatusUpdate | AgentProviderSessionUpdate

export type AgentStatusBatchTransaction = {
  getState: () => AppState
  apply: (update: AgentStatusBatchUpdate) => boolean
  afterCommit: (effect: () => void) => void
}

export type {
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
}
