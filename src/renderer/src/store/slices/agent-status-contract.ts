import type { AppState } from '../types'
import type {
  AgentStateHistoryEntry,
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentType,
  MigrationUnsupportedPtyEntry,
  ParsedAgentStatusPayload,
  TurnEndDisposition
} from '../../../../shared/agent-status-types'
import type { AgentStatusObservation } from '../../../../shared/agent-status-observation'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'
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
  /** Pane death permits cutoff/manual-unread cleanup; row dismissal preserves them so later hooks cannot resurrect cleared history. */
  paneRemoved?: boolean
}

export type DropAgentStatusByTabPrefixOptions = {
  worktreeId?: string
  /** Retraction may be contact loss; preserve cutoff/manual-unread for same-pane reconnect republication. */
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

export type AgentLaunchConfigRegistryEntry = {
  launchConfig: SleepingAgentLaunchConfig
  registeredAt: number
  identity: AgentLaunchConfigRegistrationMetadata
}

export type AgentStatusPayload = ParsedAgentStatusPayload & {
  subagentObservation?: AgentStatusEntry['subagentObservation']
  /** The host's child views for a structured session; see `AgentStatusEntry.children`. */
  children?: AgentStatusEntry['children']
  orchestration?: AgentStatusOrchestrationContext
  promptInteractionKey?: string
  restoredUnconfirmed?: boolean
  /** Optional ingress provenance, currently unread; omission preserves existing output (STA-4293, agent-status-observation.ts). */
  observation?: AgentStatusObservation
  /** `null` clears the facet; absent keeps it (the writer has no facet channel, e.g. renderer OSC). */
  programStatus?: ProgramStatusFacet | null
}

export type AgentStatusTiming = {
  /** Ordered authoritative sources may correct a prior publication clock. */
  allowOlderTimestamp?: boolean
  updatedAt?: number
  /** Observation clock for staleness; see `AgentStatusEntry.evidenceObservedAt`. */
  evidenceObservedAt?: number
  stateStartedAt?: number
  /** The host's turn start; see `AgentStatusEntry.turnStartedAt`. */
  turnStartedAt?: number
  /** The host's turn end; see `AgentStatusEntry.turnEndedAt`. */
  turnEndedAt?: number
  turnEndDisposition?: TurnEndDisposition
}

export type AgentStatusRouting = {
  tabId?: string
  worktreeId?: string
  terminalHandle?: string
  connectionId?: string | null
}

export type AgentStatusMetadata = {
  authorityRestartId?: string
  /** Structured status rows remain fresh while the host owns the session; cleared on feed loss. */
  structuredHostOwned?: true
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

/** Patch only a live row's OSC 7501 facet; no state, timing, notification or attention effects. */
export type AgentProgramStatusUpdate = {
  kind: 'programStatus'
  paneKey: string
  /** `null` clears the facet. */
  programStatus: ProgramStatusFacet | null
}

export type AgentStatusBatchUpdate =
  | AgentStatusUpdate
  | AgentProviderSessionUpdate
  | AgentProgramStatusUpdate

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
