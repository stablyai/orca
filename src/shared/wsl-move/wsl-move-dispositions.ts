/**
 * What the WSL project mover does with every piece of user state that can belong to a local WSL
 * project. Each typed store is checked for exhaustiveness at compile time, and
 * `wsl-move-dispositions.test.ts` censuses the untyped ones (localStorage modules, SQLite tables),
 * so a new field cannot ship without a decision. UI, storage and out-of-store tables live in the
 * sibling `wsl-move-*-dispositions.ts` files. `item` numbers are the inventory rows in the
 * mover design (docs/design/wsl-via-orcad-lossless-mover.md, section 2).
 */
import type { PersistedState } from '../persisted-state-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

export type WslMoveDisposition =
  /** Carried in the migration manifest; the path stage rewrites UNC to Linux. */
  | 'move'
  /** Desktop-side state rewritten in place after commit; the desktop stays its owner. */
  | 'rewrite-desktop'
  /** Rebuilt by the destination from moved state; the projection compares its inputs instead. */
  | 'rederive'
  /** A binding to a live PTY. Terminals restart on the host (quiesce and restore), so it drops. */
  | 'drop-pty-binding'
  /** Blocks the move while non-empty for the scope; nothing to carry once the gate passes. */
  | 'gate'
  /** Not tied to the project's host, or the same bytes serve both sides. */
  | 'not-applicable'
  /** A container whose fields have their own table below. */
  | 'per-field'

export type WslMoveFieldDisposition = {
  disposition: WslMoveDisposition
  item: number
  /** The desktop also keeps and rewrites its own copy (worktree ids, owner host). */
  rewriteDesktopCopy?: true
  /** Not in today's SSH manifest; D1b adds a capability-gated section for it. */
  newManifestSection?: true
  note?: string
}

export const moveDisposition = (
  item: number,
  extra: Omit<WslMoveFieldDisposition, 'disposition' | 'item'> = {}
) => ({ disposition: 'move', item, ...extra }) as const
export const notApplicableDisposition = (item: number, note?: string) =>
  ({ disposition: 'not-applicable', item, ...(note ? { note } : {}) }) as const

export const PERSISTED_STATE_DISPOSITIONS = {
  schemaVersion: notApplicableDisposition(62),
  repos: moveDisposition(1),
  projects: moveDisposition(3),
  projectHostSetups: { disposition: 'rederive', item: 4 },
  projectGroups: moveDisposition(5),
  folderWorkspaces: moveDisposition(6),
  folderWorkspaceDiffComments: moveDisposition(7, {
    note: 'Rides in folderWorkspaces[].diffComments, its in-memory home (verified).'
  }),
  sparsePresetsByRepo: moveDisposition(8),
  retiredWorktreeNamesByRepo: moveDisposition(9),
  retiredWorktreeNamesByNamespace: moveDisposition(10, {
    note: 'Local repos do write `local:<probe path>` keys; recompute for the Linux probe path, never string-map.'
  }),
  mobileClientTabSelectionsByDeviceId: moveDisposition(37),
  worktreeMeta: moveDisposition(11),
  worktreeMetaByIdentity: moveDisposition(15, {
    note: 'Readers prefer the identity row, and some rows exist only there: the effective metadata moves.'
  }),
  worktreeIdentityAliases: {
    disposition: 'rederive',
    item: 15,
    note: 'The destination mints its own canonical identities for the moved metadata.'
  },
  worktreeLineageById: moveDisposition(16),
  workspaceLineageByChildKey: moveDisposition(17),
  settings: notApplicableDisposition(62, 'Desktop-global; see SETTINGS_KEYS_NAMING_A_PATH.'),
  ui: { disposition: 'per-field', item: 38 },
  githubCache: notApplicableDisposition(21, 'Cache keyed by repoId, which the move keeps.'),
  workspaceSession: { disposition: 'per-field', item: 22 },
  workspaceSessionsByHostId: {
    disposition: 'rewrite-desktop',
    item: 22,
    note: "The desktop seeds the WSL host's session from the moved 'local' rows (D1b-7c)."
  },
  remoteLayoutSnapshots: { disposition: 'rewrite-desktop', item: 47 },
  sshTargets: notApplicableDisposition(62),
  sshTargetGenerationCounter: notApplicableDisposition(62),
  deletedSshConfigAliases: notApplicableDisposition(62),
  removedSshTargetTombstones: notApplicableDisposition(62),
  sshRemotePtyLeases: notApplicableDisposition(60),
  sshPtyConsumerRecoveries: notApplicableDisposition(60),
  migrationUnsupportedPtyEntries: { disposition: 'gate', item: 20 },
  legacyPaneKeyAliasEntries: { disposition: 'gate', item: 20 },
  automations: moveDisposition(18),
  automationRuns: moveDisposition(19, {
    note: 'An in-flight run in scope blocks the move.'
  }),
  orcadMigrationImportReceipts: notApplicableDisposition(67, 'Mover-owned.'),
  orcadMigrationEvictedReceipts: notApplicableDisposition(67, 'Mover-owned.'),
  orcadMigrationStagedCatalogs: notApplicableDisposition(68, 'Mover-owned.'),
  onboarding: notApplicableDisposition(62),
  featureInteractionTelemetryBuckets: notApplicableDisposition(62),
  codexResetCreditAttemptLedger: notApplicableDisposition(62),
  nativeChatUpgradeTipAudience: notApplicableDisposition(62)
} as const satisfies Record<keyof PersistedState, WslMoveFieldDisposition>

export const WORKSPACE_SESSION_DISPOSITIONS = {
  activeRepoId: notApplicableDisposition(32, 'repoId is kept.'),
  activeWorktreeId: moveDisposition(32, { rewriteDesktopCopy: true }),
  activeWorkspaceExecutionHostId: {
    disposition: 'rewrite-desktop',
    item: 32,
    note: "'local' becomes the WSL host for a moved focus."
  },
  activeTabId: notApplicableDisposition(32, 'Tab ids are kept.'),
  browserUrlHistory: notApplicableDisposition(31),
  workspaceDocHistory: moveDisposition(30),
  activeConnectionIdsAtShutdown: notApplicableDisposition(60),
  clientHostedBrowserCloseIntentsByEnvironment: moveDisposition(29),
  tabsByWorktree: moveDisposition(22),
  openFilesByWorktree: moveDisposition(26),
  activeFileIdByWorktree: moveDisposition(27),
  activeBrowserTabIdByWorktree: moveDisposition(29),
  activeTabTypeByWorktree: moveDisposition(27),
  activeTabIdByWorktree: moveDisposition(27),
  browserTabsByWorktree: moveDisposition(29),
  clientHostedBrowserPagesByWorktree: moveDisposition(29),
  unifiedTabs: moveDisposition(27),
  tabGroups: moveDisposition(27),
  tabGroupLayouts: moveDisposition(27),
  activeGroupIdByWorktree: moveDisposition(27),
  lastVisitedAtByWorktreeId: moveDisposition(32),
  defaultTerminalTabsAppliedByWorktreeId: moveDisposition(32),
  activeWorkspaceKey: moveDisposition(32, { rewriteDesktopCopy: true }),
  activeWorktreeIdsOnShutdown: moveDisposition(32),
  terminalLayoutsByTabId: moveDisposition(23),
  localOnlyScrollbackByTabId: moveDisposition(25, { newManifestSection: true }),
  remoteSessionIdsByTabId: { disposition: 'drop-pty-binding', item: 36 },
  browserPagesByWorkspace: moveDisposition(29),
  markdownFrontmatterVisible: moveDisposition(28),
  sleepingAgentSessionsByPaneKey: moveDisposition(33),
  explicitlySleptChatsByWorkspace: notApplicableDisposition(
    32,
    'Explicit Sleep intent belongs to the old execution host.'
  ),
  terminalPtyIncarnationsByPaneKey: {
    disposition: 'drop-pty-binding',
    item: 36
  },
  terminalTopologyRevisionByRepoId: { disposition: 'rederive', item: 35 },
  terminalSurfaceTombstonesByPaneKey: moveDisposition(34),
  closedTerminalTabTombstonesByTabId: moveDisposition(34)
} as const satisfies Record<keyof WorkspaceSessionState, WslMoveFieldDisposition>

/** Nested PTY bindings dropped wherever they appear in moved session rows (item 36). */
export const WSL_MOVE_DROPPED_PTY_BINDING_KEYS = ['ptyId', 'ptyIdsByLeafId'] as const
