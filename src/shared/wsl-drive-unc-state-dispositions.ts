/**
 * What converting a UNC Windows-drive project to its drive path (D1c) does with each saved field;
 * src/main/wsl/wsl-drive-unc-state-rewrite.ts applies it.
 */
import type { PersistedState } from './persisted-state-types'

type Disposition =
  /** Every identity string in it is re-keyed. */
  | 'rewrite'
  /** Names no local project folder, or another host's. */
  | 'keep'

/** A new field fails to compile until it has a disposition. */
export const WSL_DRIVE_UNC_STATE_DISPOSITIONS = {
  schemaVersion: 'keep',
  repos: 'rewrite',
  projects: 'rewrite',
  projectHostSetups: 'rewrite',
  projectGroups: 'rewrite',
  folderWorkspaces: 'rewrite',
  folderWorkspaceDiffComments: 'rewrite',
  sparsePresetsByRepo: 'rewrite',
  retiredWorktreeNamesByRepo: 'keep',
  // Keyed by the new-worktree folder, which the converted project recomputes on Windows.
  retiredWorktreeNamesByNamespace: 'keep',
  mobileClientTabSelectionsByDeviceId: 'rewrite',
  worktreeMeta: 'rewrite',
  worktreeMetaByIdentity: 'rewrite',
  worktreeIdentityAliases: 'rewrite',
  worktreeLineageById: 'rewrite',
  workspaceLineageByChildKey: 'rewrite',
  // Desktop-wide; a path here (the worktree folder) is not a project's.
  settings: 'keep',
  ui: 'rewrite',
  githubCache: 'keep',
  workspaceSession: 'rewrite',
  // Partitions of SSH and paired hosts; the local partition is `workspaceSession`.
  workspaceSessionsByHostId: 'keep',
  remoteLayoutSnapshots: 'keep',
  sshTargets: 'keep',
  sshTargetGenerationCounter: 'keep',
  deletedSshConfigAliases: 'keep',
  removedSshTargetTombstones: 'keep',
  sshRemotePtyLeases: 'keep',
  sshPtyConsumerRecoveries: 'keep',
  migrationUnsupportedPtyEntries: 'rewrite',
  legacyPaneKeyAliasEntries: 'rewrite',
  automations: 'rewrite',
  // Run history stays as it ran, beside its automation.
  automationRuns: 'keep',
  orcadMigrationImportReceipts: 'keep',
  orcadMigrationEvictedReceipts: 'keep',
  orcadMigrationStagedCatalogs: 'keep',
  onboarding: 'keep',
  featureInteractionTelemetryBuckets: 'keep',
  codexResetCreditAttemptLedger: 'keep',
  chatUiLaunchTipAudience: 'keep'
} as const satisfies Record<keyof PersistedState, Disposition>
