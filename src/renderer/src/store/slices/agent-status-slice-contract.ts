import type {
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
  AgentProviderSessionMetadata,
  DropAgentStatusByTabPrefixOptions,
  DropAgentStatusByWorktreeOptions,
  DropAgentStatusOptions,
  DropHibernatedAgentPaneOptions,
  RetainedAgentEntry,
  AllAgentSessionCaptureMode
} from './agent-status-contract'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type {
  ResumableTuiAgent,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${leafId}`; real-time only, not persisted. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
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

  /** Retained "done" snapshots of agents gone from `agentStatusByPaneKey`, keyed by paneKey so pane re-appearance overwrites; shared by dashboard and sidebar hover. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Durable agent sessions captured on sleep (not live rows); power the one-click CLI resume on wake. */
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>

  /** Ephemeral launch snapshots keyed by pane; hook payloads lack Orca launch settings, so the renderer supplies them from startup. */
  agentLaunchConfigByPaneKey: Record<string, AgentLaunchConfigRegistryEntry>

  /** Pane keys explicitly torn down, forbidden from re-retention on next disappearance; a one-shot suppressor consumed by the retention sync. */
  retentionSuppressedPaneKeys: Record<string, true>

  /** Terminal tabs explicitly closed this session; used to drop late in-flight IPC statuses and stale main-cache replays. */
  recentlyClosedAgentStatusTabIds: Record<string, true>

  /** Exact pane authorities retired while sibling panes in the tab stay live. */
  recentlyRetiredAgentStatusPaneKeys: Record<string, true>

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

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: AgentStatusPayload,
    terminalTitle?: string,
    timing?: AgentStatusTiming,
    routing?: AgentStatusRouting,
    metadata?: AgentStatusMetadata
  ) => void

  /** Apply ordered status updates as one status publication (generated titles and tab
   *  titles still publish after it — three total, not 2N). */
  setAgentStatuses: (updates: readonly AgentStatusBatchUpdate[]) => boolean[]

  /** Fold caller-derived updates against exact staged state, committing one status publication. */
  transactAgentStatuses: <Result>(
    operation: (transaction: AgentStatusBatchTransaction) => Result
  ) => Result

  /** Record resume identity without creating a visible turn-status row. */
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
  getAgentLaunchConfigForStatusMetadata: (
    metadata: AgentLaunchConfigStatusMetadata
  ) => SleepingAgentLaunchConfig | undefined
  clearAgentLaunchConfig: (paneKey: string) => void

  setRuntimeAgentOrchestrationByPaneKey: (
    entries: Record<string, AgentStatusOrchestrationContext>
  ) => void

  setMigrationUnsupportedPty: (entry: MigrationUnsupportedPtyEntry) => void
  clearMigrationUnsupportedPty: (ptyId: string) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix (tab close prefix-sweep). */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove stale live rows while preserving pane launch and resume identity. */
  clearTransientAgentStatuses: (connectionId: string, clearedAt: number) => void

  /** Remove a single entry AND suppress re-retention on its next disappearance (user-initiated teardown: X button, pane close). */
  dropAgentStatus: (paneKey: string, opts?: DropAgentStatusOptions) => void

  /** Remove all entries under a tab AND suppress re-retention for each (tab close — no rows may reappear). */
  dropAgentStatusByTabPrefix: (
    tabIdPrefix: string,
    opts?: DropAgentStatusByTabPrefixOptions
  ) => void

  /** Remove one auto-hibernated completed-agent pane while preserving sibling live/retained rows in the same worktree. */
  dropHibernatedAgentStatusPane: (
    worktreeId: string,
    paneKey: string,
    opts?: DropHibernatedAgentPaneOptions
  ) => void

  /** Remove all entries for a worktree AND suppress re-retention for live rows (worktree sleep/remove).
   *  Sweeps live rows by tab prefix and by main-stamped worktree attribution so worker rows that arrive before their tab don't survive. */
  dropAgentStatusByWorktree: (worktreeId: string, opts?: DropAgentStatusByWorktreeOptions) => void

  captureSleepingAgentSessionsByWorktree: (worktreeId: string, paneKeys?: string[]) => void
  /** Capture resumable agent sessions across every worktree for crash recovery or quit; mode sets live/quit precedence. */
  captureAllSleepingAgentSessions: (mode: AllAgentSessionCaptureMode) => void
  clearSleepingAgentSession: (paneKey: string) => void
  clearSleepingAgentSessionsByPaneKey: (paneKeys: readonly string[]) => void
  setSleepingAgentAutomaticResumeBlocked: (paneKey: string, blocked: boolean) => void
  clearSleepingAgentSessionsByWorktree: (worktreeId: string) => void
  pruneSleepingAgentSessions: (validWorktreeIds: Set<string>) => void

  /** Retain agent snapshots. Accepts an array so simultaneous disappearances produce a single set() with no mid-loop intermediate states. */
  retainAgents: (entries: RetainedAgentEntry[]) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss several retained entries in one set (Activity "Clear completed"). */
  dismissRetainedAgents: (paneKeys: readonly string[]) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void

  /** Clear one-shot teardown suppressors after the retention sync declines to retain the row. */
  clearRetentionSuppressedPaneKeys: (paneKeys: string[]) => void
}
