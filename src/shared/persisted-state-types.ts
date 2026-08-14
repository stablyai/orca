import type { ExecutionHostId } from './execution-host'
import type {
  RemovedSshTargetTombstone,
  SshPtyConsumerRecovery,
  SshRemotePtyLease,
  SshTarget
} from './ssh-types'
import type { Automation, AutomationRun } from './automations-types'
import type { MigrationUnsupportedPtyEntry } from './agent-status-types'
import type { FeatureInteractionTelemetryBucketState } from './feature-interactions'
import type { CodexResetCreditAttemptLedger } from './codex-reset-credit-attempt-ledger'
import type { DiffComment } from './diff-comment-types'
import type { FolderWorkspace, WorkspaceKey } from './folder-workspace-types'
import type { GlobalSettings } from './global-settings-types'
import type { IssueInfo, PRInfo } from './github/pull-request-types'
import type { OnboardingState } from './onboarding-state-types'
import type { PersistedUIState } from './persisted-ui-state-types'
import type { ProjectGroup } from './project-group-types'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { SparsePreset } from './worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

export type LegacyPaneKeyAliasEntry = {
  ptyId: string
  /** Physical pane key retained by the live process; name is persisted for compatibility (UUID keys after detach). */
  legacyPaneKey: string
  /** Current logical owner pane key. May belong to another tab after detach. */
  stablePaneKey: string
  updatedAt: number
}

/** Last tab selection a paired client made in a worktree; restores phone navigation across host restarts. */
export type PersistedMobileClientTabSelection = {
  activeTabId: string | null
  activeGroupId: string | null
  activeTabIdByGroupId: Readonly<Record<string, string>>
}

/** deviceId → worktreeId → selection. */
export type PersistedMobileClientTabSelections = Record<
  string,
  Record<string, PersistedMobileClientTabSelection>
>

// ─── Persistence shape ──────────────────────────────────────────────
export type PersistedState = {
  schemaVersion: number
  repos: Repo[]
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  /** Folder-workspace review notes, keyed by FolderWorkspace.id. Top-level, NOT nested in
   *  folderWorkspaces[]: normalizeFolderWorkspaces rebuilds each record field-by-field, so an
   *  older build drops nested fields, while unknown top-level keys round-trip untouched.
   *
   *  WRITE-ONLY PROJECTION. FolderWorkspace.diffComments is the single in-memory home; load()
   *  hydrates from this key and then deletes it from Store state, and buildStateToSave() is the
   *  only producer of it. Never read Store.state.folderWorkspaceDiffComments outside load(). */
  folderWorkspaceDiffComments?: Record<string, DiffComment[]>
  /** Sparse-checkout presets keyed by repoId. */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
  /** Per paired device last tab selection by worktree; keeps mobile navigation across host restarts. */
  mobileClientTabSelectionsByDeviceId?: PersistedMobileClientTabSelections
  worktreeMeta: Record<string, WorktreeMeta>
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<WorkspaceKey, WorkspaceLineage>
  settings: GlobalSettings
  ui: PersistedUIState
  githubCache: {
    pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
    issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
  }
  /** Legacy single-blob session, kept as the canonical 'local' host partition so an app downgrade still reads its workspace. */
  workspaceSession: WorkspaceSessionState
  /** Per-execution-host session partitions for non-'local' hosts (ssh:/runtime:); 'local' stays in workspaceSession so pre-partition builds keep working. */
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  sshTargets: SshTarget[]
  /** SSH config aliases the user deleted; suppresses re-import from ~/.ssh/config so a deleted host doesn't reappear. */
  deletedSshConfigAliases: string[]
  /** Identity records for removed SSH targets so a re-added host can re-adopt workspaces orphaned on the old target id. */
  removedSshTargetTombstones?: RemovedSshTargetTombstone[]
  sshRemotePtyLeases: SshRemotePtyLease[]
  /** Main-owned authenticated relay recovery records; never expose through renderer settings APIs. */
  sshPtyConsumerRecoveries?: SshPtyConsumerRecovery[]
  /** Live local Claude daemon session ids; seeds the live-PTY gate so early OAuth refresh can't rotate the single-use refresh token out from under a running daemon. */
  claudeLivePtySessionIds?: string[]
  migrationUnsupportedPtyEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
  automations: Automation[]
  automationRuns: AutomationRun[]
  onboarding: OnboardingState
  /** Main-owned telemetry de-dupe marker; never exposed through PersistedUIState. */
  featureInteractionTelemetryBuckets?: FeatureInteractionTelemetryBucketState
  /** Main-owned reset mutation journal. Never expose this through renderer settings APIs. */
  codexResetCreditAttemptLedger?: CodexResetCreditAttemptLedger
  /** Main-owned Open With recency (extension → application ids, most recent first); never expose through renderer settings APIs. */
  openWithRecentApplicationsByExtension?: Record<string, string[]>
}
