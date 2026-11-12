import type { AcceptedAgentStatuses } from './accepted-agent-statuses'
import type { AgentSenderPublication } from '../../../../../shared/agent-sender-associations'
import type { AgentSenderPublications } from '@/runtime/native-chat/agent-senders/agent-sender-publication-patch'
import type {
  AgentLaunchConfigRegistryEntry,
  AgentLaunchConfigRegistrationMetadata,
  AgentProviderSessionRecordMetadata,
  AgentProviderSessionRouting,
  AgentProviderSessionTiming,
  AgentStatusBatchTransaction,
  AgentStatusBatchUpdate,
  AgentStatusChangeListener,
  AgentStatusMetadata,
  AgentStatusPayload,
  AgentStatusRouting,
  AgentStatusTiming,
  DropAgentStatusByTabPrefixOptions,
  DropAgentStatusByWorktreeOptions,
  DropAgentStatusOptions,
  AllAgentSessionCaptureMode
} from './agent-status-contract'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentPaneConversationIdentity } from './agent-pane-conversation'
import type { AgentStatusStateUpdate } from './agent-status-runtime'
import type { ProgramStatusFacet } from '../../../../../shared/program-status/facet'

export type AgentStatusSlice = {
  agentSenderPublicationsByHost: AgentSenderPublications
  setAgentSenderPublication: (host: string, publication: AgentSenderPublication | undefined) => void
  /** Explicit agent status entries keyed by `${tabId}:${leafId}`; real-time only, not persisted. */
  agentStatusByPaneKey: AcceptedAgentStatuses
  /** Pane conversation identity and first session clock; transient and independent of agent occupancy. */
  agentConversationsByPaneKey: Record<string, AgentPaneConversationIdentity>
  /** Store-local committed row changes, using writer-known keys rather than map discovery. */
  subscribeAgentStatusChanges: (listener: AgentStatusChangeListener) => () => void
  /** Route external atomic status patches through the same commit boundary. */
  updateAgentStatusState: (update: AgentStatusStateUpdate) => void
  /** Main-synced dispatch metadata for live panes that may only have title-derived status in the renderer. */
  runtimeAgentOrchestrationByPaneKey: Record<string, AgentStatusOrchestrationContext>
  /** PTYs still reporting legacy numeric pane keys but with registry-backed UUID proof; stored separately from normal hook-reported status. */
  migrationUnsupportedByPtyId: Record<string, MigrationUnsupportedPtyEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number
  /** SSH connections whose transient rows were cleared and must reject renderer callbacks
   *  until a later reconnect establishes a new connection lifecycle. */
  transientClearedAgentStatusConnectionIds: Record<string, true>
  /** Arm the shared freshness timer after an external mirror writes live rows. */
  scheduleAgentStatusFreshness: () => void

  /** Durable agent sessions captured on sleep (not live rows); power the one-click CLI resume on wake. */
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>

  /** Ephemeral launch snapshots keyed by pane; hook payloads lack Orca launch settings, so the renderer supplies them from startup. */
  agentLaunchConfigByPaneKey: Record<string, AgentLaunchConfigRegistryEntry>

  /** Terminal tabs explicitly closed this session; used to drop late in-flight IPC statuses and stale main-cache replays. */
  recentlyClosedAgentStatusTabIds: Record<string, true>

  /** Exact pane authorities retired while sibling panes in the tab stay live. */
  recentlyRetiredAgentStatusPaneKeys: Record<string, true | string>

  retireAgentPaneAuthority: (
    paneKey: string,
    options?: { preserveSleepingAgentSession?: boolean }
  ) => void
  /** Lift a pane's retirement fence once a live PTY re-attaches to it. Closed tabs stay retired. */
  restoreAgentPaneAuthority: (paneKey: string) => void
  transferAgentPaneAuthority: (args: {
    fromPaneKey: string
    toPaneKey: string
    ptyId?: string | null
  }) => void

  setAgentStatus: (
    paneKey: string,
    payload: AgentStatusPayload,
    terminalTitle?: string,
    timing?: AgentStatusTiming,
    routing?: AgentStatusRouting,
    metadata?: AgentStatusMetadata
  ) => void

  /** Publish ordered status batch once; generated/tab titles publish separately (three writes, not 2N). */
  setAgentStatuses: (updates: readonly AgentStatusBatchUpdate[]) => boolean[]

  /** Fold caller-derived updates against exact staged state, committing one status publication. */
  transactAgentStatuses: <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ) => Result

  /** Patch a live row's OSC 7501 facet only (`null` clears it); false when no row or no change. */
  setAgentProgramStatus: (paneKey: string, programStatus: ProgramStatusFacet | null) => boolean

  recordAgentProviderSession: (
    paneKey: string,
    agent: ResumableTuiAgent,
    providerSession: AgentProviderSessionMetadata,
    timing?: AgentProviderSessionTiming,
    routing?: AgentProviderSessionRouting,
    metadata?: AgentProviderSessionRecordMetadata
  ) => void

  registerAgentLaunchConfig: (
    paneKey: string,
    launchConfig: SleepingAgentLaunchConfig,
    metadata?: AgentLaunchConfigRegistrationMetadata
  ) => void
  getAgentLaunchConfigForStatusEntry: (
    entry: AgentStatusEntry
  ) => SleepingAgentLaunchConfig | undefined
  clearAgentLaunchConfig: (paneKey: string) => void

  setRuntimeAgentOrchestrationByPaneKey: (
    entries: Record<string, AgentStatusOrchestrationContext>,
    producerHost?: string
  ) => void

  setMigrationUnsupportedPty: (entry: MigrationUnsupportedPtyEntry) => void
  clearMigrationUnsupportedPty: (ptyId: string) => void

  removeAgentStatus: (paneKey: string) => void

  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove stale live rows while preserving pane launch and resume identity. */
  clearTransientAgentStatuses: (connectionId: string, clearedAt: number) => void

  /** Dismiss a live row or remove a dead pane. */
  dropAgentStatus: (paneKey: string, opts?: DropAgentStatusOptions) => void

  /** Retire a closed tab and remove its live entries. */
  dropAgentStatusByTabPrefix: (
    tabIdPrefix: string,
    opts?: DropAgentStatusByTabPrefixOptions
  ) => void

  /** Remove the live status of one auto-hibernated pane, preserving sibling rows. */
  dropHibernatedAgentStatusPane: (worktreeId: string, paneKey: string) => void

  /** Sweep terminal status by tab and workspace attribution, including agents whose tabs have not hydrated. */
  dropAgentStatusByWorktree: (worktreeId: string, opts?: DropAgentStatusByWorktreeOptions) => void

  captureSleepingAgentSessionsByWorktree: (worktreeId: string, paneKeys?: string[]) => void
  /** Capture resumable agent sessions across every worktree for crash recovery or quit; mode sets live/quit precedence. */
  captureAllSleepingAgentSessions: (mode: AllAgentSessionCaptureMode) => void
  clearSleepingAgentSession: (paneKey: string) => void
  /** Keeps a pane resume handle; replaces only the exact captured record, preserving newer work. */
  rememberSleepingAgentSession: (
    record: SleepingAgentSessionRecord,
    replaces?: SleepingAgentSessionRecord
  ) => void
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
  clearSleepingAgentSessionsByWorktree: (worktreeId: string) => void
  pruneSleepingAgentSessions: (validWorktreeIds: Set<string>) => void
}
