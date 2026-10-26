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
import type { NativeChatUpgradeTipAudience } from './native-chat-upgrade-tip-audience'
import type { DiffComment } from './diff-comment-types'
import type { FolderWorkspace, WorkspaceKey } from './folder-workspace-types'
import type { GlobalSettings } from './global-settings-types'
import type { IssueInfo, PRInfo } from './github/pull-request-types'
import type { OnboardingState } from './onboarding-state-types'
import type { PersistedUIState } from './persisted-ui-state-types'
import type { ProjectGroup } from './project-group-types'
import type { RemoteLayoutSnapshot } from './remote-layout-snapshot'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import type { SparsePreset } from './worktree/create-types'
import type { RetiredNameRegistry } from './worktree/retired-name-registry'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { OrcadMigrationEvictedReceipt } from './orcad-migration/orcad-migration-evicted-receipts'
import type {
  OrcadMigrationImportReceipt,
  OrcadMigrationStagedCatalog
} from './orcad-migration/orcad-migration-manifest'

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
  /** Top-level tabs the client showed, most recent last. */
  recentTabIds?: string[]
}

/** deviceId → worktreeId → selection. */
export type PersistedMobileClientTabSelections = Record<
  string,
  Record<string, PersistedMobileClientTabSelection>
>

export type PersistedState = {
  schemaVersion: number
  repos: Repo[]
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  /** Keep folder review notes top-level: older normalizers strip nested fields but round-trip unknown top-level keys.
   * Write-only projection: load hydrates FolderWorkspace.diffComments and deletes this key from Store state;
   * only buildStateToSave produces it. Never read Store.state.folderWorkspaceDiffComments outside load. */
  folderWorkspaceDiffComments?: Record<string, DiffComment[]>
  /** Sparse-checkout presets keyed by repoId. */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
  /** Never reuse issued workspace names: cwd-keyed agent state could leak from prior occupants. Keep compact watermark tiers
   * for each repo; deletion does not free names. Union repos sharing a cwd namespace and retain remote namespace tombstones. */
  retiredWorktreeNamesByRepo?: Record<string, RetiredNameRegistry>
  /** Compacted remote cwd tombstones outlive repo ids, so remove/re-add cannot reissue a path. */
  retiredWorktreeNamesByNamespace?: Record<string, RetiredNameRegistry>
  /** Per paired device last tab selection by worktree; keeps mobile navigation across host restarts. */
  mobileClientTabSelectionsByDeviceId?: PersistedMobileClientTabSelections
  worktreeMeta: Record<string, WorktreeMeta>
  /** Canonical host/instance metadata; optional for legacy profiles. */
  worktreeMetaByIdentity?: Record<string, WorktreeMeta>
  /** Host-qualified locator aliases to canonical identity keys. */
  worktreeIdentityAliases?: Record<string, string[]>
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
  /** Paired server’s last display layout, keyed by environment and written only by the snapshot recorder;
   * separate from runtime:<env> partitions that older builds overwrite. */
  remoteLayoutSnapshots?: Record<string, RemoteLayoutSnapshot>
  sshTargets: SshTarget[]
  /** Highest SSH target registration generation issued; prevents identity reuse after rollback. */
  sshTargetGenerationCounter?: number
  /** SSH config aliases the user deleted; suppresses re-import from ~/.ssh/config so a deleted host doesn't reappear. */
  deletedSshConfigAliases: string[]
  /** Identity records for removed SSH targets so a re-added host can re-adopt workspaces orphaned on the old target id. */
  removedSshTargetTombstones?: RemovedSshTargetTombstone[]
  sshRemotePtyLeases: SshRemotePtyLease[]
  /** Main-owned authenticated relay recovery records; never expose through renderer settings APIs. */
  sshPtyConsumerRecoveries?: SshPtyConsumerRecovery[]
  migrationUnsupportedPtyEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
  automations: Automation[]
  automationRuns: AutomationRun[]
  /** Catalogs an orcad imported, so a retried commit returns the same receipt. */
  orcadMigrationImportReceipts?: OrcadMigrationImportReceipt[]
  /** Commits whose full receipt aged out of the list above; still answered as committed. */
  orcadMigrationEvictedReceipts?: OrcadMigrationEvictedReceipt[]
  /** Catalogs staged on an orcad and not yet committed or aborted. */
  orcadMigrationStagedCatalogs?: OrcadMigrationStagedCatalog[]
  onboarding: OnboardingState
  /** Main-owned telemetry de-dupe marker; never exposed through PersistedUIState. */
  featureInteractionTelemetryBuckets?: FeatureInteractionTelemetryBucketState
  /** Main-owned reset mutation journal. Never expose this through renderer settings APIs. */
  codexResetCreditAttemptLedger?: CodexResetCreditAttemptLedger
  /** Main-owned, decided once on the first load of the upgrade; never derived from live settings. */
  nativeChatUpgradeTipAudience?: NativeChatUpgradeTipAudience
}
