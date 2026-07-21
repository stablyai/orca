/* eslint-disable max-lines */
import type { ExecutionHostId } from './execution-host'
import type { RemovedSshTargetTombstone, SshRemotePtyLease, SshTarget } from './ssh-types'
import type { Automation, AutomationExecutionTargetType, AutomationRun } from './automations-types'
import type { WorkspaceSource } from './workspace-source'
import type { GitHubProjectSettings } from './github-project-types'
import type {
  AgentStatusState,
  AgentType,
  MigrationUnsupportedPtyEntry
} from './agent-status-types'
import type { VoiceSettings } from './speech-types'
import type { WorkspaceCleanupUIState } from './workspace-cleanup'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'
import type { GitLabProjectSettings } from './gitlab-types'
import type { TaskProvider } from './task-providers'
import type { FeatureTipId } from './feature-tips'
import type { ContextualTourId } from './contextual-tours'
import type {
  FeatureInteractionState,
  FeatureInteractionTelemetryBucketState
} from './feature-interactions'
import type { GitBranchChangeStatus } from './git-status-types'
import type { KeybindingOverrides, TerminalShortcutPolicy } from './keybindings'
import type { RepoIcon } from './repo-icon'
import type { AppIconId } from './app-icon'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from './source-control-ai-types'
import type { StartupCommandDelivery } from './codex-startup-delivery'
import type { AgentKind, LaunchSource, RequestKind } from './telemetry-events'
import type { SleepingAgentLaunchConfig, SleepingAgentSessionRecord } from './agent-session-resume'
import type { ClaudeAgentTeamsMode } from './claude-agent-teams-tmux-compat'
import type { TerminalCustomTheme } from './terminal-custom-themes'
import type { UiLanguage } from './ui-language'
import type { ForkSyncMode } from './git-fork-sync'
import type { GitRemoteIdentity } from './git-remote-identity'
import type {
  GlobalWindowsRuntimeDefault,
  LocalWindowsRuntimePreference
} from './project-execution-runtime'
import type { UsagePercentageDisplay } from './usage-percentage-display'
import type { StatusBarUsageMode } from './status-bar-usage-mode'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'

// Re-exported for backward compat with renderer call sites that import
// `WorkspaceCreateTelemetrySource` from '../../../shared/types'.
export type { WorkspaceSource as WorkspaceCreateTelemetrySource } from './workspace-source'
export type { TaskProvider } from './task-providers'
export type {
  GitBranchChangeStatus,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GitFileStatus,
  GitStagingArea,
  GitStatusEntry,
  GitStatusResult,
  GitSubmoduleStatus,
  GitUncommittedEntry,
  GitUpstreamStatus
} from './git-status-types'

// ─── Shell PATH hydration ────────────────────────────────────────────
// Why: shared so the main-side `HydrationResult` discriminator and the
// telemetry schema in `telemetry-events.ts` stay in lockstep without
// `src/shared/` taking a forbidden import from `src/main/`. A compile-time
// guard in telemetry-events.ts asserts the schema enum matches this alias —
// adding a new failure mode without updating both places fails the build.
export type ShellHydrationFailureReason =
  | 'none'
  | 'no_shell'
  | 'timeout'
  | 'spawn_error'
  | 'empty_path'

export type PathSource = 'shell_hydrate' | 'sync_seed_only'

// ─── Repo ────────────────────────────────────────────────────────────
export type RepoKind = 'git' | 'folder'

/**
 * Per-repo user choice for where issues are fetched and filed.
 *
 * Why three states, not two: storage must distinguish "user explicitly chose
 * upstream" from "heuristic happens to resolve to upstream right now." Collapsing
 * the two would let a remote-topology change (someone removes `upstream`, or
 * adds one later) silently move the effective source — the exact silent-source-
 * switch class the upstream-issue-source design rejects.
 *
 * - `'auto'` (or undefined): honor the heuristic in `getIssueOwnerRepo`
 *   (upstream-if-exists, else origin). Initial state for every repo.
 * - `'upstream'`: explicit upstream. Wins over heuristic and future topology
 *   changes. Falls back to origin if `upstream` remote vanishes, with a toast.
 * - `'origin'`: explicit origin. Same precedence.
 */
export type IssueSourcePreference = 'upstream' | 'origin' | 'auto'
export type { ForkSyncMode, GitForkSyncExpectedUpstream, GitForkSyncResult } from './git-fork-sync'
export type ExternalWorktreeVisibility = 'hide' | 'show'

export type ProjectProviderIdentity = {
  provider: 'github'
  owner: string
  repo: string
}

export type Project = {
  id: string
  displayName: string
  badgeColor: string
  repoIcon?: RepoIcon | null
  kind?: RepoKind
  providerIdentity?: ProjectProviderIdentity
  gitRemoteIdentity?: GitRemoteIdentity
  /** Local Windows projects inherit the global runtime default unless this override is set. */
  localWindowsRuntimePreference?: LocalWindowsRuntimePreference
  sourceRepoIds: string[]
  createdAt: number
  updatedAt: number
}

export type ProjectUpdateArgs = {
  projectId: string
  updates: Partial<Pick<Project, 'localWindowsRuntimePreference'>>
}

export type ProjectHostSetupState = 'ready' | 'not-set-up' | 'setting-up' | 'error' | 'unsupported'
export type ProjectHostSetupMethod =
  | 'legacy-repo'
  | 'imported-existing-folder'
  | 'cloned'
  | 'provisioned'
export type RepoProjectHostSetupMethod = Extract<
  ProjectHostSetupMethod,
  'imported-existing-folder' | 'cloned'
>

export type ProjectHostSetup = {
  id: string
  projectId: string
  hostId: ExecutionHostId
  repoId: string
  path: string
  displayName: string
  kind?: RepoKind
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  worktreeBasePath?: string
  hookSettings?: RepoHookSettings
  gitUsername?: string
  setupState: ProjectHostSetupState
  setupMethod: ProjectHostSetupMethod
  sourceControlAi?: RepoSourceControlAiOverrides
  createdAt: number
  updatedAt: number
}

export type ProjectHostSetupExistingFolderArgs = {
  projectId: string
  hostId: ExecutionHostId
  path: string
  kind?: RepoKind
  displayName?: string
  setupMethod?: RepoProjectHostSetupMethod
}

export type ProjectHostSetupCreateArgs = {
  projectId: string
  hostId: ExecutionHostId
  setupId?: string
  path?: string
  kind?: RepoKind
  displayName?: string
  worktreeBasePath?: string
  gitUsername?: string
  setupState?: ProjectHostSetupState
  setupMethod?: Exclude<ProjectHostSetupMethod, 'legacy-repo'>
}

export type ProjectHostSetupCloneArgs = {
  projectId: string
  hostId: ExecutionHostId
  url: string
  destination: string
  displayName?: string
}

export type ProjectHostSetupUpdateArgs = {
  setupId: string
  updates: Partial<
    Pick<
      ProjectHostSetup,
      | 'displayName'
      | 'path'
      | 'worktreeBasePath'
      | 'setupState'
      | 'setupMethod'
      | 'gitUsername'
      | 'kind'
    >
  >
}

export type ProjectHostSetupDeleteArgs = {
  setupId: string
}

export type ProjectHostSetupResult = {
  project: Project
  setup: ProjectHostSetup
  repo: Repo
}

export type ProjectHostSetupCreateResult = {
  project: Project
  setup: ProjectHostSetup
}

export type ProjectHostSetupUpdateResult = {
  project: Project
  setup: ProjectHostSetup
  repo?: Repo
}

export type ProjectHostSetupDeleteResult = {
  project: Project
  setup: ProjectHostSetup
  repo?: Repo
}

export type Repo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  repoIcon?: RepoIcon | null
  /** Set when the repo is a fork: the upstream/parent owner/repo. Drives the
   *  default avatar (upstream owner, not the personal fork) and the fork
   *  indicator. Absent = not a fork, or fork status not yet resolved. */
  upstream?: GitHubRepositoryIdentity | null
  addedAt: number
  kind?: RepoKind
  gitUsername?: string
  worktreeBaseRef?: string
  /** Optional repo-scoped workspace root override. Relative paths resolve from `path`. */
  worktreeBasePath?: string
  hookSettings?: RepoHookSettings
  /** SSH target ID for remote repos. null/undefined = local. */
  connectionId?: string | null
  /**
   * Explicit execution owner for this repo. Runtime-host repos need this
   * because they otherwise look identical to local repos (`connectionId: null`).
   */
  executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
  /** Per-repo override for issue-source resolution. `undefined` is treated
   *  identically to `'auto'`; writers leave it undefined on creation so
   *  existing persisted records stay forward-compatible. */
  issueSourcePreference?: IssueSourcePreference
  /** Controls Orca's fork-default-branch sync offer for repos with upstream metadata. */
  forkSyncMode?: ForkSyncMode
  /** Canonical identity for the repo remote Orca should use for provider-level grouping. */
  gitRemoteIdentity?: GitRemoteIdentity | null
  /** Controls whether worktrees Orca did not create appear in the sidebar. */
  externalWorktreeVisibility?: ExternalWorktreeVisibility
  /** True when the repo predates hidden-by-default external worktrees. */
  externalWorktreeVisibilityLegacy?: boolean
  /** One-shot guard for the optional existing-user visibility prompt. */
  externalWorktreeVisibilityPromptDismissedAt?: number
  /** Hidden external worktree paths acknowledged by Keep hidden on the inbox. */
  externalWorktreeInboxBaselinePaths?: string[]
  /** External worktree paths explicitly imported while global visibility stays hide. */
  importedExternalWorktreePaths?: string[]
  /** User permanently opted out of the new-external-worktree inbox for this repo. */
  externalWorktreeDiscoverySuppressedAt?: number
  /** Paths (relative to the primary checkout) that should be APFS clone-copied
   *  on macOS when possible, otherwise symlinked, into newly created worktrees.
   *  Undefined/empty means no shared paths are created for this repo. */
  symlinkPaths?: string[]
  /** Durable sidebar-only repo organization. Execution remains repo-scoped. */
  projectGroupId?: string | null
  /** User-authored ordering inside the project group or ungrouped bucket. */
  projectGroupOrder?: number
  /** Repo-specific source-control AI overrides. Missing fields inherit global settings. */
  sourceControlAi?: RepoSourceControlAiOverrides
  /** Transitional source for ProjectHostSetup.setupMethod while Repo remains compatibility storage. */
  projectHostSetupMethod?: RepoProjectHostSetupMethod
}

export type ProjectGroupCreatedFrom = 'manual' | 'folder-scan' | 'migration'

export type ProjectGroup = {
  id: string
  name: string
  parentPath: string | null
  /** SSH target ID for folder-backed groups imported from a remote root. */
  connectionId?: string | null
  /** Renderer-owned host stamp for groups fetched from a runtime environment. */
  executionHostId?: string | null
  parentGroupId: string | null
  createdFrom: ProjectGroupCreatedFrom
  tabOrder: number
  isCollapsed: boolean
  color: string | null
  createdAt: number
  updatedAt: number
}

export type WorkspaceScope =
  | { type: 'worktree'; worktreeId: string }
  | { type: 'folder'; folderWorkspaceId: string }

export type WorkspaceKey = `worktree:${string}` | `folder:${string}`

export type FolderWorkspace = {
  id: string
  projectGroupId: string
  name: string
  folderPath: string
  /** SSH target ID for folder workspaces whose folder path lives remotely. */
  connectionId?: string | null
  linkedTask: FolderWorkspaceLinkedTask | null
  comment: string
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  /** User-authored sidebar ordering. Higher values render earlier in Manual sort. */
  manualOrder?: number
  workspaceStatus?: WorkspaceStatus
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
  firstAgentMessageRenameError?: string | null
  lastActivityAt: number
  createdAt: number
  updatedAt: number
}

export type FolderWorkspaceLinkedTask = {
  provider: 'github' | 'gitlab' | 'linear' | 'jira'
  type: 'issue' | 'pr' | 'mr'
  number: number
  title: string
  url: string
  linearIdentifier?: string
  jiraIdentifier?: string
  repoId?: string
}

export type NestedRepoScanOptions = {
  maxDepth?: number
  maxRepos?: number
  timeoutMs?: number | null
}

export type NestedRepoCandidate = {
  path: string
  displayName: string
  depth: number
}

export type NestedRepoScanResult = {
  selectedPath: string
  selectedPathKind: 'git_repo' | 'non_git_folder'
  repos: NestedRepoCandidate[]
  truncated: boolean
  timedOut: boolean
  stopped: boolean
  durationMs: number
  maxDepth: number
  maxRepos: number
  timeoutMs: number | null
}

export type ProjectGroupImportMode = 'group' | 'separate'

export type ProjectGroupImportProjectResult = {
  path: string
  projectId?: string
  status: 'imported' | 'already-known' | 'failed'
  error?: string
}

export type ProjectGroupImportResult = {
  group?: ProjectGroup
  projects: ProjectGroupImportProjectResult[]
  importedCount: number
  alreadyKnownCount: number
  failedCount: number
}

export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupAgentStartupPolicy = 'start-immediately' | 'wait-for-setup'
export type SetupDecision = 'inherit' | 'run' | 'skip'
export type HookCommandSourcePolicy = 'shared-only' | 'local-only' | 'run-both'

/**
 * Envelope returned by the `repos:getBaseRefDefault` IPC handler.
 *
 * Why: declared in `shared/` rather than colocated with the handler so the
 * preload bridge and renderer can import the same named type. Before this
 * lived in `src/main/git/repo.ts` — the preload layer cannot import from
 * `src/main/`, which forced three sites to inline the same structural shape
 * and risk silent drift.
 *
 * Why `remoteCount`: BaseRefPicker renders a multi-remote hint when the repo
 * has more than one configured remote; piggybacking the count on this IPC
 * avoids a second round-trip.
 *
 * Why `defaultBaseRef` (not `default`): `default` is a reserved word and is
 * awkward to destructure.
 */
export type BaseRefDefaultResult = {
  defaultBaseRef: string | null
  remoteCount: number
}

export type BaseRefSearchResult = {
  refName: string
  localBranchName: string
}

// ─── Worktree (git-level) ────────────────────────────────────────────
export type GitWorktreeInfo = {
  path: string
  head: string
  branch: string
  isBare: boolean
  isSparse?: boolean
  locked?: boolean
  lockReason?: string
  /** True when Git reports the worktree as prunable (its directory is gone but
   *  the registration remains). Detected via the `prunable` porcelain field
   *  (Git ≥ 2.36) or a path-existence probe on older Git. */
  prunable?: boolean
  prunableReason?: string
  /** True for the repo's main working tree (the first entry from `git worktree list`).
   *  Linked worktrees created via `git worktree add` have this set to false. */
  isMainWorktree: boolean
}

/** Head/branch snapshot read from Git metadata files without spawning Git.
 *  Carries background-worktree freshness when status-only churn includes a
 *  real head move (external commit/amend/reset) that must not re-enter the
 *  structural `worktrees:changed` fanout. */
export type WorktreeHeadIdentity = {
  worktreePath: string
  head: string
  /** Full ref (e.g. `refs/heads/main`), or null for a detached HEAD. */
  branch: string | null
}

// ─── Worktree (app-level, enriched) ──────────────────────────────────
export type WorkspaceStatus = string

export type WorkspaceStatusDefinition = {
  id: WorkspaceStatus
  label: string
  color?: string
  icon?: string
}

export type Worktree = {
  id: string // `${repoId}::${path}`
  instanceId?: string
  repoId: string
  /** Durable project identity. Optional while legacy repo-only workspaces migrate. */
  projectId?: string
  /** Execution host that owns the workspace. Optional for pre-project-host metadata. */
  hostId?: ExecutionHostId
  /** Host-specific setup used to create/run this workspace. */
  projectHostSetupId?: string
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  linkedLinearIssue: string | null
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  // Why: parallel slots for non-GitHub work-item references. Kept as separate
  // fields (rather than reusing linkedIssue / linkedPR with a provider
  // discriminator) so the persistence layer is unambiguous when a user
  // has remotes from several providers on the same repo, and so the
  // existing GitHub renderer code keeps reading linkedPR / linkedIssue
  // unchanged. Optional on the type so existing test fixtures and
  // persisted older worktrees that never carried these fields continue
  // to typecheck and load without migration.
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  /** User-authored sidebar ordering. Higher values render earlier in Manual sort. */
  manualOrder?: number
  lastActivityAt: number
  /** Set once when Orca creates the worktree. Absent for worktrees discovered
   *  on disk or persisted before this field existed. Used by the sidebar to
   *  grant newly-created worktrees a short grace window at the top of Recent,
   *  immune to ambient PTY-bump reordering in other worktrees. */
  createdAt?: number
  /** Agent selected when Orca originally created the worktree. Used only to
   *  seed a replacement terminal if the user later reopens the worktree after
   *  closing every visible surface. */
  createdWithAgent?: TuiAgent
  /** True while an auto-named workspace is waiting for the first agent message
   *  to drive the branch/title rename. */
  pendingFirstAgentMessageRename?: boolean
  /** Holds the last auto-rename generation failure message so the sidebar can
   *  show a "rename failed" badge. null/undefined when there is no failure
   *  (never attempted, succeeded, or only a benign skip). */
  firstAgentMessageRenameError?: string | null
  sparseDirectories?: string[]
  sparseBaseRef?: string
  /** ID of the saved preset this worktree was created from, if any. Cleared
   *  when the worktree is no longer sparse on refresh. */
  sparsePresetId?: string
  /** Intended create base for stale-base probes. Persisted metadata, not UI drift state. */
  baseRef?: string
  /** Remote/branch Orca should publish review commits to when it created this worktree. */
  pushTarget?: GitPushTarget
  /** Path-derived worktree ids this worktree had before folder renames. */
  priorWorktreeIds?: string[]
  workspaceStatus?: WorkspaceStatus
  diffComments?: DiffComment[]
  mobileDiffReview?: MobileDiffReviewState
  automationProvenance?: AutomationWorkspaceProvenance
} & GitWorktreeInfo

export type AutomationWorkspaceProvenance = {
  kind: 'created-by-automation'
  automationId: string
  automationNameSnapshot: string
  automationRunId: string
  automationRunTitleSnapshot: string
  createdAt: number
  executionTargetType: AutomationExecutionTargetType
  executionTargetId: string
  projectId: string
  repoId?: string
  hostId?: ExecutionHostId
}

export type AutomationWorkspaceProvenanceRequest = {
  automationId: string
  automationRunId: string
  dispatchToken: string
  createRequestId: string
}

export type GitPushTarget = {
  remoteName: string
  branchName: string
  remoteUrl?: string
  /** True when Orca added this remote while preparing a fork-PR worktree. */
  remoteCreated?: boolean
}

export type GitHubPrStartPoint = {
  baseBranch: string
  /** Review target branch to use for Source Control compare after creating from a PR head SHA. */
  compareBaseRef?: string
  pushTarget?: GitPushTarget
  /** Verified PR head commit. Present when checkout can be tied to a stable SHA. */
  headSha?: string
  /** Exact local branch name to create/reuse when the PR head is a safe same-repo branch. */
  branchNameOverride?: string
  /** Fork PRs: false when "Allow edits from maintainers" is off; a push to the fork may be rejected. */
  maintainerCanModify?: boolean
}

// ─── Worktree metadata (persisted user-authored fields only) ─────────
export type WorktreeMeta = {
  /** Immutable per-workspace-instance ID used to reject stale lineage after path reuse. */
  instanceId?: string
  /** See Worktree.projectId. Persisted for project-first workspace ownership. */
  projectId?: string
  /** See Worktree.hostId. Persisted for project-first workspace ownership. */
  hostId?: ExecutionHostId
  /** See Worktree.projectHostSetupId. Persisted for project-first workspace ownership. */
  projectHostSetupId?: string
  displayName: string
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  linkedLinearIssue: string | null
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  /** Optional for backward compatibility — see Worktree.linkedGitLabMR. */
  linkedGitLabMR?: number | null
  /** Optional for backward compatibility — see Worktree.linkedGitLabIssue. */
  linkedGitLabIssue?: number | null
  /** Optional for backward compatibility — see Worktree.linkedBitbucketPR. */
  linkedBitbucketPR?: number | null
  /** Optional for backward compatibility — see Worktree.linkedAzureDevOpsPR. */
  linkedAzureDevOpsPR?: number | null
  /** Optional for backward compatibility — see Worktree.linkedGiteaPR. */
  linkedGiteaPR?: number | null
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  /** User-authored sidebar ordering. Higher values render earlier in Manual sort. */
  manualOrder?: number
  lastActivityAt: number
  /** See {@link Worktree.createdAt}. Persisted to orca-data.json. */
  createdAt?: number
  /** See {@link Worktree.createdWithAgent}. Persisted to orca-data.json. */
  createdWithAgent?: TuiAgent
  /** See {@link Worktree.pendingFirstAgentMessageRename}. */
  pendingFirstAgentMessageRename?: boolean
  /** See {@link Worktree.firstAgentMessageRenameError}. */
  firstAgentMessageRenameError?: string | null
  sparseDirectories?: string[]
  sparseBaseRef?: string
  sparsePresetId?: string
  /** Intended create base for stale-base probes. Persisted metadata, not UI drift state. */
  baseRef?: string
  /** True when Orca checked out a pre-existing local branch that delete must not prune. */
  preserveBranchOnDelete?: boolean
  /** See {@link Worktree.pushTarget}. Persisted so refreshed worktree lists keep the target. */
  pushTarget?: GitPushTarget
  /** Explicit marker stamped when Orca creates the worktree. */
  orcaCreatedAt?: number
  orcaCreationSource?: 'desktop' | 'runtime' | 'cli' | 'ssh'
  /** Workspace layout active when Orca created the worktree. */
  orcaCreationWorkspaceLayout?: OrcaWorkspaceLayout
  /** User-assigned workspace board status for manual sidebar organization. */
  workspaceStatus?: WorkspaceStatus
  diffComments?: DiffComment[]
  /** Path-derived worktree ids this worktree had before its folder was renamed
   *  on disk (the id embeds the path). Lets the daemon's session GC and registry
   *  hydration recognize sessions minted under an old id instead of reaping
   *  them. Self-prunes when the worktree is deleted. */
  priorWorktreeIds?: string[]
  mobileDiffReview?: MobileDiffReviewState
  /** System-owned provenance for workspaces created by automation new-per-run dispatches. */
  automationProvenance?: AutomationWorkspaceProvenance
}

export type WorktreeOwnership = 'orca-managed' | 'external' | 'unknown-legacy' | 'agent-scratch'

export type DetectedWorktreeListSource = 'git' | 'metadata-fallback' | 'session-fallback'

export type DetectedWorktree = Worktree & {
  ownership: WorktreeOwnership
  selectedCheckout: boolean
  visible: boolean
}

export type DetectedWorktreeListResult = {
  repoId: string
  authoritative: boolean
  source: DetectedWorktreeListSource
  worktrees: DetectedWorktree[]
}

export type WorktreeLineageOrigin = 'orchestration' | 'cli' | 'manual'
export type WorktreeLineageCaptureConfidence = 'explicit' | 'inferred'
export type WorktreeLineageCaptureSource =
  | 'explicit-cli-flag'
  | 'env-workspace'
  | 'cwd-context'
  | 'terminal-context'
  | 'orchestration-context'
  | 'active-workspace'
  | 'manual-action'

export type WorktreeLineageCapture = {
  source: WorktreeLineageCaptureSource
  confidence: WorktreeLineageCaptureConfidence
}

export type WorktreeLineage = {
  worktreeId: string
  worktreeInstanceId: string
  parentWorktreeId: string
  parentWorktreeInstanceId: string
  origin: WorktreeLineageOrigin
  capture: WorktreeLineageCapture
  orchestrationRunId?: string
  taskId?: string
  coordinatorHandle?: string
  createdByTerminalHandle?: string
  createdAt: number
}

export type WorkspaceLineage = {
  childWorkspaceKey: WorkspaceKey
  childInstanceId?: string | null
  parentWorkspaceKey: WorkspaceKey
  parentInstanceId?: string | null
  origin: WorktreeLineageOrigin
  capture: WorktreeLineageCapture
  taskId?: string
  orchestrationRunId?: string
  coordinatorHandle?: string
  createdByTerminalHandle?: string
  createdAt: number
}

export type WorktreeLineageWarningCode =
  | 'LINEAGE_PARENT_CONTEXT_MISSING'
  | 'LINEAGE_PARENT_CONTEXT_CONFLICT'
  | 'LINEAGE_PARENT_INSTANCE_STALE'

export type WorktreeLineageWarning = {
  code: WorktreeLineageWarningCode
  message: string
  details?: Record<string, unknown>
}

// ─── Diff line comments ──────────────────────────────────────────────
// Why: users leave review notes on specific lines of the modified side of
// a diff so they can be handed back to an AI agent (pasted into a terminal
// or used to bootstrap a new agent session). Stored on WorktreeMeta so the
// existing persistence layer writes them to orca-data.json automatically.
export type DiffCommentSource = 'diff' | 'markdown'
export type DiffReviewScope = 'unstaged' | 'staged' | 'branch'

export type MobileDiffReviewFileState = {
  key: string
  filePath: string
  oldPath?: string
  scope: DiffReviewScope
  lastOpenedAt?: number
  lastSeenDiffIdentity?: string
  reviewedAt?: number
  reviewDiffIdentity?: string
}

export type MobileDiffReviewState = {
  version: 1
  updatedAt?: number
  completedAt?: number
  files: Record<string, MobileDiffReviewFileState>
}

export type DiffComment = {
  id: string
  worktreeId: string
  filePath: string
  /** Undefined means a legacy diff note. */
  source?: DiffCommentSource
  /** Exact text selected when creating a markdown note, when available. */
  selectedText?: string
  /** Inclusive range start. Must be <= lineNumber when present. */
  startLine?: number
  lineNumber: number
  body: string
  createdAt: number
  updatedAt?: number
  /** Set after the note has been handed to an agent. Edits clear it. */
  sentAt?: number
  scope?: DiffReviewScope
  oldPath?: string
  diffIdentity?: string
  // Reserved for future "comments on the original side" — always 'modified' in v1.
  side: 'modified'
}

// ─── Tab Group Layout ───────────────────────────────────────────────
export type TabGroupSplitDirection = 'horizontal' | 'vertical'

export type TabGroupLayoutNode =
  | { type: 'leaf'; groupId: string }
  | {
      type: 'split'
      direction: TabGroupSplitDirection
      first: TabGroupLayoutNode
      second: TabGroupLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

// ─── Unified Tab ────────────────────────────────────────────────────
export type TabContentType =
  | 'terminal'
  | 'editor'
  | 'diff'
  | 'conflict-review'
  | 'check-details'
  | 'browser'
  | 'simulator'

export type WorkspaceVisibleTabType = 'terminal' | 'editor' | 'browser' | 'simulator'
export type CtrlTabOrderMode = 'mru' | 'sequential'

export type Tab = {
  id: string // UUID for terminals, filePath for editors (preserves current convention)
  entityId: string // ID of the backing content (terminal tab ID, file path, browser workspace ID)
  groupId: string
  worktreeId: string
  contentType: TabContentType
  label: string // display title (auto-derived from PTY or filename)
  generatedLabel?: string | null
  quickCommandLabel?: string | null
  customLabel: string | null
  color: string | null
  sortOrder: number
  createdAt: number
  isPreview?: boolean // preview tabs get replaced by next single-click open
  isPinned?: boolean // pinned tabs survive "close others"
  /** Why: per-tab rendering mode for coding-agent terminals. `'chat'` shows the
   *  native chat view as an overlay while the live terminal stays mounted
   *  underneath; `'terminal'` (the default for legacy/missing) shows the raw
   *  xterm. Optional so sessions persisted before this field hydrate cleanly. */
  viewMode?: 'terminal' | 'chat'
}

export type TabGroup = {
  id: string
  worktreeId: string
  activeTabId: string | null
  tabOrder: string[] // canonical visual order of tab IDs
  /** Per-group MRU stack (oldest → most-recent at the tail). Drives which tab
   *  becomes active when the current active tab closes: we pop back to the
   *  previously-active tab instead of jumping to a visual neighbor. Scoped to
   *  the group so split panes keep independent histories. Optional because
   *  sessions persisted before this field was added still hydrate cleanly —
   *  hydration seeds from activeTabId. */
  recentTabIds?: string[]
}

// ─── Terminal Tab (legacy — used by persistence and TerminalContentSlice) ─
export type TerminalTab = {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  /** Stable fallback label for default-named terminals ("Terminal 1", etc.).
   *  Why: agent CLIs overwrite the live title via OSC updates, but Orca still
   *  needs the original terminal label for numbering and reset behavior. */
  defaultTitle?: string
  /** Stable opt-in label derived from the first known agent prompt. */
  generatedTitle?: string | null
  /** Stable label from the tab-bar Quick Command that created this terminal. */
  quickCommandLabel?: string | null
  customTitle: string | null
  color: string | null
  /** Pinned tabs survive "close others"; host-persisted for remote servers. */
  isPinned?: boolean
  /** Per-tab view preference (terminal xterm vs native chat); host-persisted so
   *  paired clients converge. Optional: older persisted tabs default to 'terminal'. */
  viewMode?: 'terminal' | 'chat'
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
  /** Why: records the shell this tab was opened with (e.g. 'wsl.exe') so the
   *  PTY and tab icon stay stable even if the default shell setting changes
   *  later. Older persisted tabs may omit this field. */
  shellOverride?: string
  /** Why: explorer-created terminals can start below the workspace root while
   *  still belonging to that workspace for tab/session ownership. */
  startupCwd?: string
  /** Why: the coding-harness agent Orca launched in this tab. Lets the tab bar
   *  show the provider icon immediately, before the agent emits its first hook
   *  event (a freshly-launched, idle agent reports no live status yet). Live
   *  hook status overrides this once the agent does anything. Plain terminals
   *  and manually-started agents omit it. */
  launchAgent?: TuiAgent
  /** Why: when `setActiveWorktree` bumps generation on all-dead tabs to drive a
   *  TerminalPane remount, the fresh PTY that results is caused by navigation,
   *  not by the user doing work. Without this flag the resulting
   *  `updateTabPtyId` call would call `bumpWorktreeActivity` and flip the
   *  sidebar's recency sort on every click — the reorder-on-click bug. The
   *  flag is set by `setActiveWorktree` and consumed by the activation-driven
   *  PTY lifecycle calls that follow, which then suppress activity bumps and
   *  `sortEpoch` increments. Split layouts use a numeric count because one tab
   *  can remount several panes. Never persisted — it is a transient handoff. */
  pendingActivationSpawn?: boolean | number
}

export type BrowserHistoryEntry = {
  url: string
  normalizedUrl: string
  title: string
  lastVisitedAt: number
  visitCount: number
}

export type BrowserLoadError = {
  code: number
  description: string
  validatedUrl: string
}

export type BrowserCertificateFailure = {
  challengeId: string
  browserPageId: string
  errorCode: number | null
  error: string
  origin: string
  displayHost: string
  canProceed: boolean
  observedAt: number
}

export type BrowserCertificateProceedFailureReason =
  | 'expired'
  | 'changed'
  | 'ineligible'
  | 'missing'
  | 'navigated'

export type BrowserCertificateProceedResult =
  | { ok: true }
  | { ok: false; reason: BrowserCertificateProceedFailureReason }

// Why: BrowserPage persists the active viewport preset so CDP emulation can be
// reapplied on reload/navigation without the user re-picking from the toolbar.
export type BrowserViewportPresetId =
  | 'mobile-s'
  | 'mobile-m'
  | 'mobile-l'
  | 'tablet'
  | 'laptop'
  | 'laptop-l'
  | 'desktop'

export type BrowserViewportOverride = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export type BrowserPage = {
  id: string
  workspaceId: string
  worktreeId: string
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
  // Why: remote-owned worktrees can still host client-local fallback browser
  // pages until headless remote runtimes support real browser panes.
  browserRuntimeEnvironmentId?: string | null
  /** Active CDP viewport emulation preset. null = default (fill pane, no CDP override) */
  viewportPresetId?: BrowserViewportPresetId | null
}

export type BrowserWorkspace = {
  id: string
  worktreeId: string
  /** Stable display label for the outer Orca tab ("Browser 1", "Browser 2", …).
   *  Optional so sessions persisted before this field was added fall back
   *  gracefully to the URL-derived label in getBrowserTabLabel. */
  label?: string
  // Why: each browser workspace binds to exactly one session profile at creation
  // time. The profile determines which Electron partition (and thus which
  // cookies/storage) the guest webview uses. Absent means the legacy shared
  // partition, which keeps backward compat with workspaces persisted before
  // session profiles existed.
  sessionProfileId?: string | null
  // Why: runtime-created tabs resolve profile partition in main. Persisting it
  // keeps isolated storage stable when the renderer profile mirror is stale.
  sessionPartition?: string | null
  activePageId?: string | null
  pageIds?: string[]
  // Why: the active page owns real browser chrome state now, but the top-level
  // Orca tab strip still renders one workspace entry. Mirror the active page's
  // title/url/loading metadata here so existing workspace-level UI can stay
  // stable while Phase 2 introduces nested browser pages.
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
}

export type BrowserTab = BrowserWorkspace

export type BrowserSessionProfileScope = 'default' | 'isolated' | 'imported'

export type BrowserSessionProfileSource = {
  browserFamily:
    | 'chrome'
    | 'chromium'
    | 'arc'
    | 'edge'
    | 'firefox'
    | 'safari'
    | 'comet'
    | 'helium'
    | 'manual'
  profileName?: string
  importedAt: number
}

export type BrowserSessionProfile = {
  id: string
  scope: BrowserSessionProfileScope
  partition: string
  label: string
  source: BrowserSessionProfileSource | null
}

export type BrowserCookieImportSummary = {
  totalCookies: number
  importedCookies: number
  skippedCookies: number
  domains: string[]
}

export type BrowserCookieImportResult =
  | { ok: true; profileId: string; summary: BrowserCookieImportSummary }
  | { ok: false; reason: string }

export type TerminalPaneSplitDirection = 'vertical' | 'horizontal'

export type TerminalPaneLayoutNode =
  | {
      type: 'leaf'
      leafId: string
    }
  | {
      type: 'split'
      direction: TerminalPaneSplitDirection
      first: TerminalPaneLayoutNode
      second: TerminalPaneLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

export type TerminalLayoutSnapshot = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  /** Live PTY IDs per leaf for in-session remounts such as tab-group moves.
   *  Not used for app restart because PTYs are transient processes. */
  ptyIdsByLeafId?: Record<string, string>
  /** Serialized terminal buffers per leaf for scrollback restoration on restart. */
  buffersByLeafId?: Record<string, string>
  /** Durable scrollback snapshot refs per leaf; raw bytes live outside session JSON. */
  scrollbackRefsByLeafId?: Record<string, string>
  /** User-assigned pane titles, keyed by stable layout leaf UUID.
   *  Persisted alongside buffers via the existing session:set flow. */
  titlesByLeafId?: Record<string, string>
}

/** Minimal subset of OpenFile persisted across restarts.
 *  Only edit-mode files are saved — diffs, conflict reviews, and other
 *  transient views are reconstructed on demand from git state. */
export type PersistedOpenFile = {
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isPreview?: boolean
  runtimeEnvironmentId?: string | null
  /** Unsaved editor buffer captured for hot exit; presence restores the tab dirty. */
  dirtyDraftContent?: string
  /** Signature of the disk content the dirty draft is based on; lets restore
   *  re-derive a changed-on-disk conflict from ground truth. */
  lastKnownDiskSignature?: string
  /** Why: a read-only tab (AI Vault View Log) must survive restart still
   *  read-only; persisted only when true so old sessions stay writable. */
  readOnly?: boolean
  /** Opt-in streaming append for a read-only local log tab. */
  liveTail?: boolean
}

export type WorkspaceSessionState = {
  activeRepoId: string | null
  /** Scope-aware active owner for folder workspaces. Legacy worktree UI still reads activeWorktreeId. */
  activeWorkspaceKey?: WorkspaceKey | null
  activeWorktreeId: string | null
  activeTabId: string | null
  /** Keys may be legacy raw worktree IDs or canonical WorkspaceKey values. */
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** Worktree IDs that had at least one tab with a live PTY at shutdown.
   *  Used on startup to eagerly re-spawn PTY processes so the Active filter
   *  works immediately after restart. */
  activeWorktreeIdsOnShutdown?: string[]
  /** Editor files that were open at shutdown, keyed by worktree ID.
   *  Only edit-mode files are persisted — diffs and conflict views are
   *  transient and not restored. */
  openFilesByWorktree?: Record<string, PersistedOpenFile[]>
  /** Per-worktree active editor file ID (filePath) at shutdown. */
  activeFileIdByWorktree?: Record<string, string | null>
  /** Per-file markdown preview front-matter visibility. Absent entry means hidden. */
  markdownFrontmatterVisible?: Record<string, boolean>
  /** Persisted browser workspaces, keyed by worktree ID. */
  browserTabsByWorktree?: Record<string, BrowserWorkspace[]>
  /** Persisted browser pages, keyed by workspace ID. */
  browserPagesByWorkspace?: Record<string, BrowserPage[]>
  /** Per-worktree active browser workspace ID at shutdown. */
  activeBrowserTabIdByWorktree?: Record<string, string | null>
  /** Per-worktree active tab type (terminal vs editor vs browser) at shutdown. */
  activeTabTypeByWorktree?: Record<string, WorkspaceVisibleTabType>
  /** Global browser URL history for address bar autocomplete. */
  browserUrlHistory?: BrowserHistoryEntry[]
  /** Per-worktree last-active terminal tab ID at shutdown. */
  activeTabIdByWorktree?: Record<string, string | null>
  /** Unified tab model — present when saved by a build that includes TabsSlice.
   *  Read-path checks for this first; falls back to legacy fields if absent. */
  unifiedTabs?: Record<string, Tab[]>
  /** Tab group model — present alongside unifiedTabs. */
  tabGroups?: Record<string, TabGroup[]>
  /** Persisted split layout tree per worktree. */
  tabGroupLayouts?: Record<string, TabGroupLayoutNode>
  /** Per-worktree focused group at shutdown. */
  activeGroupIdByWorktree?: Record<string, string>
  /** SSH target IDs that were connected at shutdown. Used on startup to
   *  auto-reconnect before attempting remote PTY reattach. */
  activeConnectionIdsAtShutdown?: string[]
  /** Maps tab IDs to their remote relay PTY session IDs. Populated at
   *  shutdown from renderer state so remote PTYs can be reattached via
   *  the relay's pty.attach RPC on startup. */
  remoteSessionIdsByTabId?: Record<string, string>
  /** Per-worktree focus-recency timestamps used by the Cmd+J empty-query
   *  ordering. Separate from worktree.lastActivityAt (background signal)
   *  and worktreeNavHistory (Back/Forward stack). See
   *  docs/cmd-j-empty-query-ordering.md. Absent in sessions written by
   *  older builds — hydration tolerates missing/partial maps and the
   *  active worktree is seeded on first restore. */
  lastVisitedAtByWorktreeId?: Record<string, number>
  /** Worktrees whose repo-defined default terminal tabs have already been
   *  considered. Persisted so closing all tabs and re-opening the workspace
   *  does not recreate the template. */
  defaultTerminalTabsAppliedByWorktreeId?: Record<string, true>
  /** Provider-session resume records captured when workspaces sleep. */
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
}

export type WorkspaceSessionPatch = Partial<WorkspaceSessionState>

// ─── GitHub ──────────────────────────────────────────────────────────
export type PRState = 'open' | 'closed' | 'merged' | 'draft'
export type IssueState = 'open' | 'closed'
export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral'

export type PRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
export type PRReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

export type PRConflictSummary = {
  baseRef: string
  baseCommit: string
  commitsBehind: number
  files: string[]
  localMergeState?: 'clean'
}

export type GitHubRepositoryIdentity = { owner: string; repo: string }

export type GitHubPRMergeMethod = 'merge' | 'squash' | 'rebase'

export type GitHubPRMergeMethodSettings = {
  defaultMethod: GitHubPRMergeMethod
  allowedMethods: Record<GitHubPRMergeMethod, boolean>
}

export type PRInfo = {
  number: number
  title: string
  state: PRState
  url: string
  checksStatus: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  reviewDecision?: PRReviewDecision | null
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  // Why: check-runs are keyed by the PR head commit, not the mutable branch name.
  // Keeping the head SHA in cached PR metadata lets the checks panel poll the
  // correct commit without re-querying GitHub or guessing from local branch refs.
  headSha?: string
  // Why: a merged branch-matched PR stays visible when the worktree head is one
  // of the PR's own commits (behind update-branch/web commits). Cache staleness
  // checks must honor that confirmation without re-querying GitHub.
  confirmedContainedHeadOid?: string
  // Why: the worktree HEAD OID this merged linked PR was confirmed to have
  // diverged from (a definite not-contained probe). Head-scoped, not a bare
  // boolean, so a PR-number-coalesced refresh broadcast cannot clear a sibling
  // worktree whose own head is still on the PR's line of work. Clearing a
  // durable linked PR requires this positive signal for that exact head, never
  // the mere absence of a containment confirmation after a rate-limit/error.
  headDivergedFromMergedPRAtOid?: string
  /** Target branch name for PR-created worktree compare-base repair. */
  baseRefName?: string
  /** PR head branch name. Lets linked-PR consumers detect that the worktree
   *  has switched to a different branch and the durable link is stale. */
  headRefName?: string
  prRepo?: GitHubRepositoryIdentity
  headRepo?: GitHubRepositoryIdentity
  conflictSummary?: PRConflictSummary
}

/**
 * Discriminates a classified GitHub PR-refresh failure. The renderer maps these
 * to stable, non-destructive empty-state copy; a `hard` subset (auth, permission,
 * repo_unavailable, gh_unavailable) means the existing-review lookup is currently
 * impossible and must hide the Create composer.
 */
export type PRRefreshErrorType =
  | 'rate_limited'
  | 'auth'
  | 'network'
  | 'permission'
  | 'repo_unavailable'
  | 'gh_unavailable'
  | 'server_error'
  | 'unknown'

// Backward-compatible name used by outage-copy consumers added on main.
export type PRRefreshUpstreamErrorType = PRRefreshErrorType

export type PRRefreshOutcome =
  | { kind: 'found'; pr: PRInfo; fetchedAt: number }
  | { kind: 'no-pr'; fetchedAt: number }
  | {
      kind: 'upstream-error'
      errorType: PRRefreshErrorType
      message: string
      fetchedAt: number
      // Unified retry schedule (see docs/reference/pr-panel-refresh-guidance.md).
      // `nextAutoRetryAt`: earliest time main expects to auto-retry this key.
      // `retryDisabledUntil`: earliest time a manual Retry / refreshPRNow is
      // accepted (rate-limit gates only, never ordinary network/auth backoff).
      nextAutoRetryAt?: number
      retryDisabledUntil?: number
    }

export type GitHubPRRefreshReason = 'visible' | 'active' | 'post-push' | 'manual' | 'swr'

export type GitHubPRRefreshEnqueueResult =
  | { kind: 'queued' }
  | { kind: 'skipped'; skippedReason: 'validation-denied' | 'validation-backoff' }
  | { kind: 'fallback' }

export type GitHubPRRefreshAlias = {
  cacheKey: string
  repoId?: string
  repoPath: string
  branch: string
  worktreeId?: string
  connectionId?: string | null
  executionHostId?: string | null
  linkedPRNumber?: number | null
  fallbackPRNumber?: number | null
  fallbackPRSource?: 'explicit' | 'pr-cache' | 'hosted-review' | null
  // Why: request-time worktree HEAD. Merged branch-matched PRs are only visible
  // for heads that belong to the PR, and refresh consumers need this snapshot to
  // clear a durable linked PR once main confirms the head diverged.
  currentHeadOid?: string | null
}

export type GitHubPRRefreshCandidate = GitHubPRRefreshAlias & {
  repoKind: RepoKind
  repoId: string
  isBare?: boolean
  isArchived?: boolean
  connectionId?: string | null
  executionHostId?: string | null
  connectionState?: 'connected' | 'disconnected' | 'unknown'
  cachedFetchedAt?: number | null
  cachedHasPR?: boolean | null
  cachedPRState?: PRState | null
  cachedChecksStatus?: CheckStatus | null
  cachedMergeable?: PRMergeableState | null
  cachedMergeStateStatus?: string | null
  localGitOptions?: { wslDistro?: string }
}

export type GitHubPRRefreshSkippedReason =
  | 'fresh'
  | 'not-git'
  | 'bare'
  | 'archived'
  | 'disconnected'
  | 'remote'
  | 'rate-limit'

type GitHubPRRefreshEventBase = {
  sequence: number
  reason: GitHubPRRefreshReason
  aliases: GitHubPRRefreshAlias[]
  requestStartedAt?: number
}

export type GitHubPRRefreshEvent =
  | (GitHubPRRefreshEventBase & {
      outcome: PRRefreshOutcome
      status?: never
      pausedUntil?: never
      skippedReason?: never
    })
  | (GitHubPRRefreshEventBase & {
      status: 'queued' | 'in-flight'
      outcome?: never
      pausedUntil?: never
      skippedReason?: never
    })
  | (GitHubPRRefreshEventBase & {
      status: 'paused'
      pausedUntil: number
      skippedReason: 'rate-limit'
      outcome?: never
    })
  | (GitHubPRRefreshEventBase & {
      status: 'skipped'
      skippedReason: GitHubPRRefreshSkippedReason
      outcome?: never
      pausedUntil?: never
    })

export type PRCheckDetail = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'timed_out'
    | 'neutral'
    | 'skipped'
    | 'pending'
    // Why: a check suite needing manual action (e.g. a workflow awaiting "Approve
    // and run") has no check run and is absent from statusCheckRollup, yet blocks
    // auto-merge (GitHub returns "unstable status"). Surface it as its own state.
    | 'action_required'
    | null
  url: string | null
  checkRunId?: number
  workflowRunId?: number
}

export type PRCheckAnnotation = {
  path: string | null
  startLine: number | null
  endLine: number | null
  annotationLevel: string | null
  title: string | null
  message: string
  rawDetails: string | null
}

export type PRCheckStep = {
  name: string
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

export type PRCheckJob = {
  id: number | null
  name: string
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  url: string | null
  logTail: string | null
  steps: PRCheckStep[]
}

export type PRCheckRunDetails = {
  name: string
  status: PRCheckDetail['status'] | string | null
  conclusion: PRCheckDetail['conclusion'] | string | null
  url: string | null
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  title: string | null
  summary: string | null
  text: string | null
  annotations: PRCheckAnnotation[]
  jobs: PRCheckJob[]
}

export type GitHubRerunPRChecksResult = { ok: true; count: number } | { ok: false; error: string }

export type GitHubReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes'

export type GitHubReaction = {
  content: GitHubReactionContent
  count: number
}

export type PRComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  reactions?: GitHubReaction[]
  /** File path for inline review comments (absent for top-level conversation comments). */
  path?: string
  /** GraphQL node ID of the review thread — present only for inline review comments.
   *  Used to resolve/unresolve the thread via GitHub's GraphQL API. */
  threadId?: string
  /** Whether the review thread has been resolved. Only meaningful when threadId is set. */
  isResolved?: boolean
  /** True when GitHub no longer maps the thread to the current diff. */
  isOutdated?: boolean
  /** End line of the review annotation (1-based). */
  line?: number
  /** Start line of the review annotation range (1-based). Absent for single-line comments. */
  startLine?: number
  /** True when GitHub identifies the author as a bot (REST `user.type === 'Bot'` or
   *  GraphQL `__typename === 'Bot'`). Preferred over login-string heuristics because
   *  third-party review bots (e.g. qodo-ai-reviewer, coderabbitai) don't follow a
   *  predictable naming convention. Absent when the data source can't report it
   *  (non-GitHub fallbacks via `gh pr view`). */
  isBot?: boolean
}

export type GitHubIssueTimelineTarget = {
  type: 'issue' | 'pr'
  number: number
  title: string
  url: string
  repository?: string
}

export type GitHubIssueTimelineItem = {
  id: string
  event:
    | 'assigned'
    | 'unassigned'
    | 'mentioned'
    | 'cross-referenced'
    | 'closed'
    | 'reopened'
    | 'moved_columns_in_project'
  actor: string
  actorAvatarUrl: string
  createdAt: string
  assignee?: string
  source?: GitHubIssueTimelineTarget
  closer?: GitHubIssueTimelineTarget
  stateReason?: string | null
  previousColumnName?: string | null
  columnName?: string | null
  projectName?: string | null
}

export type GitHubCommentResult = { ok: true; comment: PRComment } | { ok: false; error: string }

export type IssueInfo = {
  number: number
  title: string
  state: IssueState
  url: string
  labels: string[]
}

export type GitHubViewer = {
  login: string
  email: string | null
}

export type GitHubAssignableUser = {
  login: string
  name: string | null
  avatarUrl: string
}

export type GitHubPRCheckSummary = {
  state: 'success' | 'failure' | 'pending' | 'none'
  total: number
  passed: number
  failed: number
  pending: number
}

export type GitHubPRReviewSummary = {
  login: string
  state?: string | null
  avatarUrl?: string | null
}

export type GitHubPRFileViewedState = 'DISMISSED' | 'VIEWED' | 'UNVIEWED'

export type GitHubWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: 'open' | 'closed' | 'merged' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  // Why: GHE user logins don't exist on github.com, so the github.com/{login}.png
  // fallback 404s. Carry the API-provided avatar_url so github.com + Enterprise
  // both render; absent on the gh-pr-view path (gh omits avatar), then the UI
  // falls back to the login URL and finally an initials placeholder. See #8784.
  authorAvatarUrl?: string
  branchName?: string
  baseRefName?: string
  // Why: PR checks are keyed by head commit; carrying this lets task rows use
  // the cached check-runs endpoint instead of one `gh pr checks` call per row.
  headSha?: string
  prRepo?: GitHubRepositoryIdentity
  additions?: number
  deletions?: number
  changedFiles?: number
  reviewDecision?: PRReviewDecision | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  assignees?: GitHubAssignableUser[]
  checksSummary?: GitHubPRCheckSummary
  mergeable?: PRMergeableState
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  maintainerCanModify?: boolean
  // Why: true when a PR's head lives on a fork (headRepositoryOwner !== selected repo owner).
  // The Start-from picker passes this to resolvePrBase so fork heads use
  // refs/pull/<N>/head for creation and a separate PR-head push target.
  isCrossRepository?: boolean
  /** Why: required because the cross-repo view merges items from every selected
   *  repo — the table row's repo pill and the "open in browser" fallback need
   *  to know which repo an item came from. Stamped by the renderer fetcher
   *  (`fetchWorkItems`) and by optimistic stubs on the new-issue path. */
  repoId: string
}

export type GitHubPRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** GitHub marks files above its diff size limit as binary-like; we skip content fetches for these. */
  isBinary: boolean
  /** Modified-side line numbers that GitHub accepts for inline review comments. */
  reviewCommentLineNumbers?: number[]
  /** GitHub's per-viewer review state. DISMISSED means new changes arrived after the file was viewed. */
  viewerViewedState?: GitHubPRFileViewedState
}

export type GitHubPRFileContents = {
  original: string
  modified: string
  originalIsBinary: boolean
  modifiedIsBinary: boolean
  originalTooLarge?: boolean
  modifiedTooLarge?: boolean
}

export type GitHubPRReviewCommentInput = {
  repoPath: string
  prNumber: number
  commitId: string
  path: string
  line: number
  startLine?: number
  body: string
}

export type GitHubWorkItemDetails = {
  // Why: main-process doesn't know Orca's Repo.id, so this inner item omits
  // repoId. The renderer stamps it when routing the details through the store.
  item: Omit<GitHubWorkItem, 'repoId'>
  body: string
  comments: PRComment[]
  /** Issue-only provider activity such as assignment, references, project moves, and state changes. */
  timelineItems?: GitHubIssueTimelineItem[]
  /** Only set for PRs. Head/base SHAs used by the Files tab to fetch per-file content. */
  headSha?: string
  baseSha?: string
  /** GraphQL node ID required by GitHub's file-viewed mutations. Only set for PRs. */
  pullRequestId?: string
  checks?: PRCheckDetail[]
  files?: GitHubPRFile[]
  /** Only set for PRs. True when the file fetch failed (rate limit, auth,
   *  unresolved remote) rather than the PR genuinely having no changed files. */
  filesUnavailable?: boolean
  participants?: GitHubAssignableUser[]
  /** Logins of current assignees. Only set for issues. */
  assignees?: string[]
}

// ─── Linear ─────────────────────────────────────────────────────────
export type LinearViewer = {
  displayName: string
  email: string | null
  organizationId?: string
  organizationName: string
  organizationUrlKey?: string
}

export type LinearWorkspace = LinearViewer & {
  id: string
  organizationId: string
  isLegacy?: true
  credentialRevision?: number
}

export type LinearWorkspaceSelection = string | 'all'
export type LinearWorkspaceSelector = LinearWorkspaceSelection | undefined
export type LinearConcreteWorkspaceId = string

export type LinearWorkspaceError = {
  workspaceId: string
  workspaceName?: string
  type: 'auth' | 'rate_limited' | 'network' | 'unknown'
  message: string
}

export type LinearCollectionResult<T> = {
  items: T[]
  errors?: LinearWorkspaceError[]
  hasMore?: boolean
}

export type LinearConnectionStatus = {
  connected: boolean
  viewer: LinearViewer | null
  workspaces?: LinearWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: LinearWorkspaceSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type LinearIssue = {
  id: string
  workspaceId?: string
  workspaceName?: string
  identifier: string
  title: string
  branchName?: string
  description?: string
  url: string
  state: {
    name: string
    type: string
    color: string
  }
  team: {
    id: string
    name: string
    key: string
  }
  project?: LinearProjectSummary
  subIssues?: LinearIssueChildSummary[]
  labels: string[]
  labelIds: string[]
  assignee?: {
    id: string
    displayName: string
    avatarUrl?: string
  }
  estimate?: number | null
  priority: number
  dueDate?: string | null
  updatedAt: string
}

export type LinearProjectSummary = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  url?: string
  color?: string
  icon?: string
  description?: string
  content?: string
  status?: LinearProjectStatusSummary
  health?: string | null
  priority?: number | null
  priorityLabel?: string | null
  lead?: LinearProjectMemberSummary
  members?: LinearProjectMemberSummary[]
  teams?: {
    id: string
    name: string
    key?: string
  }[]
  labels?: {
    id: string
    name: string
    color?: string
  }[]
  startDate?: string | null
  targetDate?: string | null
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
  canceledAt?: string | null
  startedAt?: string | null
  progress?: number | null
  scope?: number | null
  issueCount?: number
  completedIssueCount?: number
}

export type LinearProjectStatusSummary = {
  id: string
  name: string
  type?: string
  color?: string
}

export type LinearProjectMemberSummary = {
  id: string
  displayName: string
  avatarUrl?: string
}

export type LinearProjectMilestoneSummary = {
  id: string
  name: string
  status?: string
  targetDate?: string | null
  progress?: number | null
}

export type LinearProjectResourceSummary = {
  id: string
  title: string
  url: string
  type?: string
}

export type LinearProjectUpdateSummary = {
  id: string
  body?: string
  health?: string | null
  url?: string
  createdAt?: string
  updatedAt?: string
  user?: LinearProjectMemberSummary
}

export type LinearProjectDetail = LinearProjectSummary & {
  milestones?: LinearProjectMilestoneSummary[]
  resources?: LinearProjectResourceSummary[]
  latestUpdate?: LinearProjectUpdateSummary
}

export type LinearCustomViewModel = 'issue' | 'project'

export type LinearCustomViewSummary = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  description?: string
  model: LinearCustomViewModel
  url?: string
  color?: string
  icon?: string
  shared?: boolean
  team?: {
    id: string
    name?: string
    key?: string
  }
  owner?: LinearProjectMemberSummary
  creator?: LinearProjectMemberSummary
  createdAt?: string
  updatedAt?: string
}

export type LinearIssueChildSummary = {
  id: string
  identifier: string
  title: string
  url: string
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  user?: {
    displayName: string
    avatarUrl?: string
  }
}

// ─── Issue Mutations ────────────────────────────────────────────────

export type GitHubCreateIssueFields = {
  labels?: string[]
  assignees?: string[]
}

export type GitHubCreateIssueResult =
  | { ok: true; number: number; url: string; bodySaveWarning?: string }
  | { ok: false; error: string }

export type GitHubIssueCloseReason = 'completed' | 'not_planned' | 'duplicate'

export type GitHubIssueUpdate = {
  state?: 'open' | 'closed'
  stateReason?: GitHubIssueCloseReason
  duplicateOf?: number
  title?: string
  // Why: body writes use the REST issue endpoint instead of `gh issue edit`
  // because that command does not consistently cover every body-edit case the
  // dialog needs.
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type GitHubPullRequestStateUpdate = {
  state: 'open' | 'closed'
}

export type LinearIssueUpdate = {
  stateId?: string
  title?: string
  description?: string
  assigneeId?: string | null
  estimate?: number | null
  priority?: number
  dueDate?: string | null
  labelIds?: string[]
  projectId?: string | null
}

export type ClassifiedError = {
  type:
    | 'permission_denied'
    | 'not_found'
    | 'issues_disabled'
    | 'validation_error'
    | 'rate_limited'
    | 'network_error'
    | 'unknown'
  message: string
}

// Why: declared here as a shared shape so IPC return envelopes and renderer
// slices can reference the same structural type without importing from main.
// Aliased as `OwnerRepo` in `src/main/github/gh-utils.ts` so main call sites
// can continue using the short local name.
export type GitHubOwnerRepo = GitHubRepositoryIdentity

// Why: GitLab-specific types live in `./gitlab-types` so they can grow
// independently from the central types file (which is touched by every
// upstream feature). Re-exported here so existing call sites
// (`from '../shared/types'`) keep working without changes.
export type {
  GitLabAssignableUser,
  GitLabAuthDiagnostic,
  GitLabCommentResult,
  GitLabDiscussionResolveResult,
  GitLabIssueInfo,
  GitLabIssueState,
  GitLabIssueUpdate,
  GitLabJobTraceResult,
  GitLabRateLimitBucket,
  GitLabRateLimitSnapshot,
  GitLabMRApprovalRule,
  GitLabMRApprovalState,
  GitLabMRFile,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  GitLabMRUpdate,
  GitLabPagedResult,
  GitLabPipelineJob,
  GitLabProjectRef,
  GitLabProjectSettings,
  GitLabRetryJobResult,
  GitLabReaction,
  GitLabTodo,
  GitLabTodoTargetType,
  GitLabViewer,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  GetGitLabRateLimitResult,
  ListMergeRequestsResult,
  MRCheckDetail,
  MRComment,
  MRInfo,
  MRListState,
  MRMergeableState,
  MRState
} from './gitlab-types'

export type {
  JiraAuthType,
  JiraComment,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateFieldAllowedValue,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraProjectStatusOrder,
  JiraSite,
  JiraSiteSelection,
  JiraStatus,
  JiraTransition,
  JiraUser,
  JiraViewer
} from './jira-types'

/**
 * GitHub API rate-limit buckets surfaced in the TaskPage header so users can
 * see remaining budget before they hit the wall. `core` = REST (5000/hr),
 * `search` = Search API (30/min — hit by countWorkItems), `graphql` =
 * GraphQL (5000 points/hr — hit by project-view + discovery). All three are
 * the buckets this app actually stresses; other buckets (e.g. code_search)
 * are not surfaced because we don't touch them.
 */
export type GitHubRateLimitBucket = {
  remaining: number
  limit: number
  /** Unix epoch seconds when the window resets. */
  resetAt: number
}

export type GitHubRateLimitSnapshot = {
  core: GitHubRateLimitBucket
  search: GitHubRateLimitBucket
  graphql: GitHubRateLimitBucket
  /** Unix epoch ms the snapshot was produced (for "fetched Xs ago" copy). */
  fetchedAt: number
}

export type GetRateLimitResult =
  | { ok: true; snapshot: GitHubRateLimitSnapshot }
  | { ok: false; error: string }

/**
 * Envelope for `gh:listWorkItems`. Carries resolved issue/PR sources so the
 * renderer can render the "Issues from owner/repo" indicator without an
 * extra IPC round-trip, and per-source classified errors so the UI can show
 * a retryable banner when (e.g.) a private upstream 403s.
 *
 * Why piggyback instead of adding `gh:resolveWorkItemSources`: the renderer
 * already round-trips this endpoint on every Tasks refresh, and the source
 * data is a 2-field-per-side metadata add — cheaper than another IPC call.
 *
 * Invariant: `items` always contains whatever succeeded; `errors.issues` indicates
 * the issues-side fetch failed, but any PR-side items that succeeded are still
 * present in `items`. Consumers should render `items` alongside the error banner.
 */
export type ListWorkItemsResult<T> = {
  items: T[]
  sources: {
    issues: GitHubOwnerRepo | null
    prs: GitHubOwnerRepo | null
    /** Raw `origin` remote resolved for this repo, independent of the
     *  user's preference. Required-nullable so the renderer can compare raw
     *  remote candidates without inferring origin from the effective PR
     *  source. */
    originCandidate: GitHubOwnerRepo | null
    /** Raw `upstream` remote resolved for this repo, independent of the
     *  user's preference. Present so the renderer's issue-source selector
     *  can always decide whether to render (upstream exists & differs from
     *  origin) and show both slugs in its tooltips, even when the user has
     *  picked 'origin' and `sources.issues` has collapsed onto origin. */
    upstreamCandidate: GitHubOwnerRepo | null
  }
  errors?: {
    issues?: ClassifiedError
  }
  /** True when the user's per-repo preference was `'upstream'` but no upstream
   *  remote is configured, so the resolver fell back to origin. Renderer uses
   *  this to surface a one-time-per-session toast. Omitted when absent so
   *  existing consumers and test fixtures don't care about it.
   *  Typed as `?: true` (not `?: boolean`) to encode the invariant "present
   *  iff fell-back" — an explicit `false` write would be a bug, so make it a
   *  compile error. */
  issueSourceFellBack?: true
}

export type LinearWorkflowState = {
  id: string
  name: string
  type: string
  color: string
  position: number
}

export type LinearLabel = {
  id: string
  name: string
  color: string
}

export type LinearMember = {
  id: string
  displayName: string
  avatarUrl?: string
}

export type LinearTeam = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  key: string
  url?: string
}

// ─── Hooks (orca.yaml) ──────────────────────────────────────────────
export type OrcaHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
  issueCommand?: string // Shared default command for linked GitHub issues
  defaultTabs?: OrcaDefaultTabTemplate[] // Terminal tabs to create once for a new worktree
  environmentRecipes?: OrcaVmRecipe[] // Project-scoped per-workspace environment recipes
  environmentRecipeDiagnostics?: OrcaVmRecipeDiagnostic[] // Non-fatal validation issues from environmentRecipes
}

export type OrcaDefaultTabTemplate = {
  title?: string
  color?: string
  command?: string
}

export type OrcaVmRecipe = {
  id: string
  name: string
  create: string
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: boolean
}

export type OrcaVmRecipeDiagnostic = {
  index: number
  field?: string
  message: string
}

export type RepoHookSettings = {
  // Why: persisted data may still include the old mode field from the earlier
  // hook UI. Keep it in the shape so existing local state reads without a migration.
  mode: 'auto' | 'override'
  setupRunPolicy?: SetupRunPolicy
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  commandSourcePolicy?: HookCommandSourcePolicy
  scripts: {
    setup: string
    archive: string
  }
}

export type WorktreeSetupLaunch = {
  runnerScriptPath: string
  envVars: Record<string, string>
  command?: string
  waitForAgentStartup?: boolean
}

export type WorktreeStartupLaunch = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
}

export type WorktreeDefaultTabsLaunch = {
  tabs: OrcaDefaultTabTemplate[]
  runCommands: boolean
}

export type WorktreeCreateTimingPhase = {
  phase: string
  startedAtMs: number
  durationMs: number
}

export type WorktreeCreateTiming = {
  totalDurationMs: number
  phases: WorktreeCreateTimingPhase[]
}

export type CreateSparseCheckoutRequest = {
  directories: string[]
  /** Set when the directories came from a saved preset and the user did not
   *  modify them — recorded on WorktreeMeta so the worktree can show "from
   *  preset X" later. Cleared if the user edited the textarea. */
  presetId?: string
}

/** A reusable per-repo sparse directory list. Saved by the user from the
 *  composer; surfaced again the next time they create a worktree in the same
 *  repo. The MVP scope (no preset) is `presetId === undefined`. */
export type SparsePreset = {
  id: string
  repoId: string
  name: string
  directories: string[]
  createdAt: number
  updatedAt: number
}

export type CreateWorktreeArgs = {
  repoId: string
  name: string
  /** Optional user-facing label to persist separately from the git-safe
   *  branch/path seed. Used when a workspace is created from a GitHub or
   *  Linear artifact whose title should remain readable in the sidebar. */
  displayName?: string
  baseBranch?: string
  /** Source Control compare target when it differs from the checkout start point. */
  compareBaseRef?: string
  /** Optional git branch to create, separate from the filesystem-safe worktree
   *  name. Used when creating from an existing branch whose local branch name
   *  legitimately contains `/` while the worktree directory must not. */
  branchNameOverride?: string
  setupDecision?: SetupDecision
  sparseCheckout?: CreateSparseCheckoutRequest
  linkedIssue?: number
  linkedPR?: number
  linkedLinearIssue?: string
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedGitLabIssue?: number
  linkedGitLabMR?: number
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  pushTarget?: GitPushTarget
  workspaceStatus?: WorkspaceStatus
  manualOrder?: number
  /** Parent workspace for in-app creates launched from a folder workspace. */
  parentWorkspace?: WorkspaceKey
  /** Agent selected in the create surface. Omitted for blank-shell creates. */
  createdWithAgent?: TuiAgent
  /** Set when the renderer knows this auto-generated branch should be renamed
   *  from the first agent message. */
  pendingFirstAgentMessageRename?: boolean
  /** Telemetry-only: which UI surface initiated this create. Threaded from
   *  the renderer entry point so main can emit `workspace_created` with the
   *  correct `source`. `unknown` is a valid wire value — an unrecognized
   *  surface emits `source: 'unknown'` rather than dropping the event, so
   *  dashboards surface enum-coverage gaps as a slice rather than as
   *  missing data. Optional on the type so older renderer code paths that
   *  pre-date this prop default to `unknown` at the IPC boundary instead
   *  of failing typecheck. */
  telemetrySource?: WorkspaceSource
  /** Optional startup command for callers that want the backend to spawn the
   *  first terminal as soon as the worktree is registered. */
  startup?: WorktreeStartupLaunch
  /** Correlates `createWorktree:progress` events back to a specific pending
   *  creation in the renderer, so concurrent background creates each drive
   *  their own status surface. Omitted by synchronous callers. */
  creationId?: string
  /** Authorizes the host to mint system-owned automation provenance. */
  automationProvenanceRequest?: AutomationWorkspaceProvenanceRequest
}

export type CreateWorktreeResult = {
  worktree: Worktree & {
    parentWorktreeId?: string | null
    childWorktreeIds?: string[]
    lineage?: WorktreeLineage | null
    workspaceLineage?: WorkspaceLineage | null
    git?: GitWorktreeInfo
  }
  lineage?: WorktreeLineage | null
  workspaceLineage?: WorkspaceLineage | null
  warnings?: WorktreeLineageWarning[]
  setup?: WorktreeSetupLaunch
  defaultTabs?: WorktreeDefaultTabsLaunch
  warning?: string
  initialBaseStatus?: WorktreeBaseStatusEvent
  localBaseRefRefresh?: LocalBaseRefRefreshResult
  localBaseRefUpdateSuggestion?: LocalBaseRefUpdateSuggestion
  startupTerminal?: {
    spawned: boolean
    handle?: string
    tabId?: string
    paneKey?: string | null
    ptyId?: string | null
    surface?: 'visible' | 'background'
  }
  timing?: WorktreeCreateTiming
}

export type PreservedWorktreeBranch = {
  branchName: string
  head?: string
}

export type RemoveWorktreeResult = {
  preservedBranch?: PreservedWorktreeBranch
}

export type ForceDeleteWorktreeBranchResult = {
  deleted: true
}

export type LocalBaseRefRefreshResult = {
  status: 'updated' | 'skipped_dirty_worktree' | 'skipped_not_fast_forward' | 'skipped_error'
  baseRef: string
  localBranch: string
  ownerWorktreePath?: string
}

export type LocalBaseRefUpdateSuggestion = {
  baseRef: string
  localBranch: string
  behind: number
}

export type WorktreeBaseStatusKind = 'checking' | 'current' | 'drift' | 'base_changed' | 'unknown'

export type WorktreeBaseStatusEvent = {
  repoId: string
  worktreeId: string
  status: WorktreeBaseStatusKind
  base: string
  /** Configured remote name parsed from `base` (longest-prefix match). Absent
   *  when classification skipped optimistic reconcile (e.g. legacy fallback). */
  remote?: string
  behind?: number
  recentSubjects?: string[]
}

export type WorktreeRemoteBranchConflictEvent = {
  repoId: string
  worktreeId: string
  remote: string
  branchName: string
}

// ─── Updater ─────────────────────────────────────────────────────────

// Why: the release object sent to the renderer omits `version` (redundant
// with the top-level UpdateStatus.version) to keep one source of truth.
export type ChangelogRelease = {
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

export type ChangelogData = {
  release: ChangelogRelease
  releasesBehind: number | null
}

export type UpdateCheckOptions = {
  includePrerelease?: boolean
  includePerfPrerelease?: boolean
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      activeNudgeId?: string
      // Why: releaseUrl is not currently populated by the update-available handler
      // (it always sends undefined). Kept on the type for the Settings page's
      // release-notes link fallback and for potential future use if the main
      // process starts extracting release URLs from electron-updater metadata.
      releaseUrl?: string
      // Why: changelog is always explicitly set by the main process — null means
      // the fetch failed or the version wasn't in the JSON (simple mode), and a
      // populated object means rich mode. Using `| null` (not `?`) avoids a
      // three-state ambiguity (undefined vs null vs present) and makes exhaustive
      // checks straightforward.
      changelog: ChangelogData | null
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string; activeNudgeId?: string }
  | { state: 'downloaded'; version: string; releaseUrl?: string; activeNudgeId?: string }
  | { state: 'error'; message: string; userInitiated?: boolean; activeNudgeId?: string }

// ─── Settings ────────────────────────────────────────────────────────
export type NotificationSettings = {
  enabled: boolean
  agentTaskComplete: boolean
  terminalBell: boolean
  suppressWhenFocused: boolean
  customSoundId:
    | 'system'
    | 'two-tone'
    | 'bong'
    | 'thump'
    | 'blip'
    | 'sonar'
    | 'blop'
    | 'ding'
    | 'clack'
    | 'beep'
    | 'custom'
  customSoundPath: string | null
  customSoundVolume: number
}

export type CodexManagedAccount = {
  id: string
  email: string
  managedHomePath: string
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxHomePath?: string | null
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type CodexManagedAccountSummary = {
  id: string
  email: string
  managedHomeRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  providerAccountId?: string | null
  workspaceLabel?: string | null
  workspaceAccountId?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

/** Live, read-only identity of the user's real ~/.codex used by the
 *  system-default (activeAccountId:null) Codex account. Orca reads this to
 *  display and attribute the system default; it never writes ~/.codex. */
export type CodexSystemDefaultIdentity = {
  /** True when ~/.codex/auth.json exists (signed in via a token file). */
  hasAuth: boolean
  /** 'oauth' = ChatGPT sign-in with an id token (has ChatGPT usage);
   *  'api-key' = env-key/custom provider (no ChatGPT usage);
   *  'none' = signed out or identity could not be resolved. */
  authKind: 'oauth' | 'api-key' | 'none'
  email: string | null
  providerAccountId: string | null
  workspaceLabel: string | null
}

export type CodexRateLimitAccountsState = {
  accounts: CodexManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: CodexManagedAccountRuntimeSelection
  /** Resolved identity of the host system-default (real ~/.codex) account.
   *  Omitted for runtimes where it is not resolved (e.g. per-distro WSL). */
  systemDefault?: CodexSystemDefaultIdentity
}

export type CodexManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}

export type ClaudeManagedAccount = {
  id: string
  email: string
  managedAuthPath: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
  authMethod: 'subscription-oauth' | 'unknown'
  organizationUuid?: string | null
  organizationName?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type ClaudeManagedAccountSummary = {
  id: string
  email: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  authMethod: 'subscription-oauth' | 'unknown'
  organizationUuid?: string | null
  organizationName?: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number
}

export type ClaudeRateLimitAccountsState = {
  accounts: ClaudeManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: ClaudeManagedAccountRuntimeSelection
}

export type ClaudeManagedAccountRuntimeSelection = {
  host: string | null
  wsl: Record<string, string | null>
}

/** All AI coding agents Orca knows how to launch. Used for the agent picker in the new-workspace
 *  flow and for the default-agent setting. Extend this union as new agents are added. */
export type TuiAgent =
  | 'claude' // Claude Code
  | 'claude-agent-teams' // Claude Code Agent Teams via Orca native panes
  | 'openclaude' // OpenClaude
  | 'codex' // OpenAI Codex
  | 'autohand' // Autohand Code CLI
  | 'opencode' // OpenCode
  | 'mimo-code'
  | 'pi' // Pi (pi.dev)
  | 'omp' // OMP (omp.sh)
  | 'gemini' // Gemini CLI
  | 'antigravity' // Google Antigravity CLI
  | 'aider' // Aider
  | 'goose' // Goose
  | 'amp' // Amp
  | 'kilo' // Kilocode
  | 'kiro' // Kiro
  | 'crush' // Charm/Crush
  | 'aug' // Augment/Auggie
  | 'cline' // Cline
  | 'codebuff' // Codebuff
  | 'command-code' // Command Code
  | 'continue' // Continue
  | 'cursor' // Cursor
  | 'droid' // Factory Droid
  | 'kimi' // Kimi
  | 'mistral-vibe' // Mistral Vibe
  | 'qwen-code' // Qwen Code
  | 'rovo' // Rovo Dev
  | 'hermes' // Hermes Agent
  | 'openclaw' // OpenClaw
  | 'copilot' // GitHub Copilot CLI
  | 'grok' // xAI Grok CLI
  | 'devin' // Devin CLI
  | 'ante' // Ante (Antigma Labs)

export type TaskViewPresetId = 'all' | 'issues' | 'review' | 'my-issues' | 'my-prs' | 'prs'

/** Where the repo setup script runs when a worktree is created.
 *  - 'new-tab': open a background tab titled "Setup" and leave focus on the first tab (default).
 *  - 'split-vertical': split the initial terminal pane with a vertical divider.
 *  - 'split-horizontal': split the initial terminal pane with a horizontal divider. */
export type SetupScriptLaunchMode = 'split-vertical' | 'split-horizontal' | 'new-tab'

/** Direction used when the setup script launch mode is a split. */
export type SetupSplitDirection = 'vertical' | 'horizontal'

export type TerminalColorOverrides = {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
  // Why: xterm.js ITheme does not expose a `bold` key, but Ghostty users
  // expect the setting to be preserved so a future renderer CSS override
  // or xterm upgrade can honour it without a migration.
  bold?: string
}

export type TerminalQuickCommandScope =
  | {
      type: 'global'
    }
  | {
      type: 'repo'
      repoId: string
    }

export type TerminalQuickCommandAction = 'terminal-command' | 'agent-prompt'

export type TerminalQuickCommandBase = {
  id: string
  label: string
  scope?: TerminalQuickCommandScope
}

export type TerminalCommandQuickCommand = TerminalQuickCommandBase & {
  action?: 'terminal-command'
  command: string
  appendEnter: boolean
}

export type TerminalAgentQuickCommand = TerminalQuickCommandBase & {
  action: 'agent-prompt'
  agent: TuiAgent
  prompt: string
}

export type TerminalQuickCommand = TerminalCommandQuickCommand | TerminalAgentQuickCommand

export type OpenInApplication = {
  id: string
  label: string
  command: string
}

export type SourceControlViewMode = 'list' | 'tree'
export type SourceControlGroupOrder = 'changes-first' | 'staged-first' | 'untracked-first'

export type LeftSidebarAppearanceMode = 'default' | 'match-terminal' | 'tinted'

export type FloatingTerminalCwdRequest = {
  path?: string
  requireTrusted?: boolean
}

/** Per-host overrides for client preferences that genuinely vary by execution
 *  host. NARROW by design: only settings whose value is meaningless to share
 *  across hosts belong here.
 *  - `displayLabel`: a client-side rename for the host shown in sidebar/pickers.
 *  - `defaultWorktreeLocation`: the host's root worktree directory; a remote
 *    SSH/runtime host has a different filesystem layout than the local Mac, so
 *    the client `workspaceDir` default cannot apply unchanged. */
export type HostSettingOverrides = {
  displayLabel?: string
  defaultWorktreeLocation?: string
}

export type GlobalSettings = {
  workspaceDir: string
  /** Per-host overrides keyed by ExecutionHostId. Effective value for a
   *  host-varying setting is `host override ?? client default`. */
  hostSettingOverrides?: Partial<Record<ExecutionHostId, HostSettingOverrides>>
  nestWorkspaces: boolean
  workspaceDirHistory?: OrcaWorkspaceLayout[]
  refreshLocalBaseRefOnWorktreeCreate: boolean
  /** Set once the user dismisses the "local main is behind" suggestion toast, so
   *  the nudge to enable refreshLocalBaseRefOnWorktreeCreate never shows again. */
  localBaseRefSuggestionDismissed: boolean
  /** When enabled, Orca renames a workspace's auto-generated creature branch to
   *  a short name derived from the first prompt once work begins. Users can
   *  still turn this off from global Git settings. */
  autoRenameBranchFromWork: boolean
  /** One-shot migration guard for the default-on rollout. Existing profiles
   *  without the guard are flipped on once; later explicit opt-outs stick. */
  autoRenameBranchFromWorkDefaultedOn?: boolean
  branchPrefix: 'git-username' | 'custom' | 'none'
  branchPrefixCustom: string
  enableGitHubAttribution: boolean
  theme: 'system' | 'dark' | 'light'
  /** Controls the left sidebar surface without changing terminal brightness. */
  leftSidebarAppearanceMode: LeftSidebarAppearanceMode
  leftSidebarTintColor?: string
  leftSidebarTintOpacity?: number
  uiLanguage: UiLanguage
  appIcon: AppIconId
  appFontFamily: string
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  editorMinimapEnabled: boolean
  /** Defaults on for profiles saved before file-editor wrapping became configurable. */
  editorWordWrap?: boolean
  /** Persisted opt-out for browser spellcheck noise in rich Markdown editing surfaces. */
  richMarkdownSpellcheckEnabled?: boolean
  /** Whether local markdown review note controls and the review panel are shown. */
  markdownReviewToolsEnabled: boolean
  /** Why: mirrors terminal selection-paste muscle memory without mutating the
   *  normal system clipboard; Linux and macOS enable it by default, Windows
   *  leaves middle-click semantics unchanged unless the user opts in. */
  primarySelectionMiddleClickPaste?: boolean
  /** One-shot migration guard for turning the Linux default on for profiles
   *  that persisted the earlier off-by-default value. */
  primarySelectionMiddleClickPasteDefaultedForLinux?: boolean
  /** One-shot migration guard for widening the terminal-style default to
   *  Linux/macOS while preserving later explicit opt-outs. */
  primarySelectionMiddleClickPasteDefaultedForTerminalDefaults?: boolean
  terminalFontSize: number
  terminalFontFamily: string
  terminalFontWeight: number
  terminalLineHeight: number
  terminalScrollSensitivity: number
  terminalFastScrollSensitivity: number
  terminalTuiScrollSensitivity: number
  /** One-shot migration guard for moving inherited TUI wheel reports from 3 to 1. */
  terminalTuiScrollSensitivityDefaultedToOne?: boolean
  /** Terminal renderer policy.
   *  - 'auto': try xterm WebGL and fall back to DOM when unsupported or risky.
   *  - 'on': always try xterm WebGL.
   *  - 'off': keep terminal rendering on xterm's DOM renderer. */
  terminalGpuAcceleration: 'auto' | 'on' | 'off'
  /** Whether to enable programming-ligatures rendering via
   *  `@xterm/addon-ligatures`.
   *  - `'auto'` (default): enabled only when the configured font is known to
   *    ship ligatures (Fira Code, JetBrains Mono, Cascadia Code, etc.). This
   *    keeps the out-of-the-box experience right for users who install a
   *    ligature font without touching settings.
   *  - `'on'` / `'off'`: explicit override. Never changes when the user
   *    switches fonts, so "off" always stays off. */
  terminalLigatures: 'auto' | 'on' | 'off'
  terminalCursorStyle: 'bar' | 'block' | 'underline'
  /** One-shot migration guard for moving inherited cursor defaults to block. */
  terminalCursorStyleDefaultedToBlock?: boolean
  terminalCursorBlink: boolean
  terminalThemeDark: string
  terminalCustomThemes?: TerminalCustomTheme[]
  terminalDividerColorDark: string
  terminalUseSeparateLightTheme: boolean
  terminalThemeLight: string
  terminalDividerColorLight: string
  terminalInactivePaneOpacity: number
  terminalActivePaneOpacity: number
  terminalPaneOpacityTransitionMs: number
  terminalDividerThicknessPx: number
  terminalBackgroundOpacity?: number
  terminalColorOverrides?: TerminalColorOverrides
  terminalPaddingX?: number
  terminalPaddingY?: number
  terminalMouseHideWhileTyping?: boolean
  terminalWordSeparator?: string
  terminalCursorOpacity?: number
  terminalQuickCommands?: TerminalQuickCommand[]
  windowBackgroundBlur?: boolean
  /** Windows-only: close (X) hides to tray instead of quitting; the tray icon is always present regardless. */
  minimizeToTrayOnClose?: boolean
  /** macOS: toggles the additive menu-bar entry (Orca survives last-window close); doesn't change Dock behavior. */
  showMenuBarIcon?: boolean
  /** Windows convention: right-click pastes; macOS/Linux keep the context menu. */
  terminalRightClickToPaste: boolean
  /** One-shot guard distinguishing the old global true default from a per-platform choice. */
  terminalRightClickToPasteDefaultedForPlatform?: boolean
  /** Windows-only: COMSPEC always points to cmd.exe, so this explicit shell (default 'powershell.exe') overrides it. */
  terminalWindowsShell: string
  /** Pins the WSL distro for terminals/agent scans instead of WSL's current global default. */
  terminalWindowsWslDistro?: string | null
  /** Account/auth location independent from the terminal shell (e.g. WSL terminals but Windows-scoped accounts). */
  localAccountRuntime: 'host' | 'wsl'
  localAccountWslDistro?: string | null
  /** Independent from the terminal shell so users can inspect Windows vs WSL agent PATH state without changing it. */
  localAgentRuntime?: 'host' | 'wsl'
  localAgentWslDistro?: string | null
  /** Why: global is only the default policy; project-level runtime preference wins. */
  localWindowsRuntimeDefault: GlobalWindowsRuntimeDefault
  /** 'auto' resolves to PowerShell 7+ when present, else falls back to inbox Windows PowerShell. */
  terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
  terminalFocusFollowsMouse: boolean
  /** X11/gnome-terminal "copy on select": selecting text auto-copies to the clipboard; default off. */
  terminalClipboardOnSelect: boolean
  /** Enables OSC 52 clipboard writes for TUIs (SSH clipboard bridge); default off since OSC 52 is a clipboard-exfiltration vector. */
  terminalAllowOsc52Clipboard: boolean
  /** Experimental Claude Agent Teams; native panes use a tmux-compatible shim so teammate output stays on the normal PTY path. */
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  /** Where the repo setup script runs on workspace create; defaults to a background "Setup" tab to keep the main terminal usable. */
  setupScriptLaunchMode: SetupScriptLaunchMode
  terminalScrollbackRows: number
  /** Optional app-level proxy for Electron networking and local PTYs; empty preserves system/inherited proxy env. */
  httpProxyUrl?: string
  /** Optional semicolon/comma/newline-separated bypass rules for httpProxyUrl. */
  httpProxyBypassRules?: string
  /** Why: corporate TLS-intercepting proxies can break HTTP/2 downloads; opt-in Chromium process-wide HTTP/1.1 switch. */
  electronHttp1CompatibilityMode?: boolean
  /** Opt-in in-app browsing (isolated guest surface); default keeps links opening in the system browser. */
  openLinksInApp: boolean
  /** Worktree-scoped localhost hostnames to distinguish tabs; opt-in since a non-localhost host can break apps binding cookies/sessions to localhost. */
  localhostWorktreeLabelsEnabled?: boolean
  /** Tracks the one-time first-use prompt for terminal link routing (avoid silently changing where links open). */
  openLinksInAppPreferencePrompted: boolean
  /** Opt-in: open new coding-agent tabs in native chat instead of the raw terminal; optional for legacy settings. */
  openAgentTabsInChatByDefault?: boolean
  /** Experimental native chat surface for Claude/Codex sessions; off by default. */
  experimentalNativeChat?: boolean
  /** Last explicit native-chat model + option selections; live panes need an applied/dispatched record before showing a value. */
  nativeChatSessionOptions?: PersistedNativeChatSessionOptions
  /** Extra launcher rows for the worktree "Open in" submenu. VS Code is always shown first. */
  openInApplications?: OpenInApplication[]
  /** Deprecated: migration/backward-compat only. Use PersistedUIState.rightSidebarOpen. */
  rightSidebarOpenByDefault: boolean
  showGitIgnoredFiles?: boolean
  /** Preferred Source Control changes layout. Per-user, not per-workspace. */
  sourceControlViewMode: SourceControlViewMode
  /** Preferred Source Control group order. Per-user, not per-workspace. */
  sourceControlGroupOrder: SourceControlGroupOrder
  /** Compare base defaults to the branch upstream instead of the repo default; affects only the compare/diff view, not the PR/rebase target. Per-user. */
  sourceControlCompareAgainstUpstream: boolean
  /** Whether to show the Orca app name in the titlebar. */
  showTitlebarAppName: boolean
  /** Hides the Tasks sidebar button (also removes it from keyboard navigation). */
  showTasksButton: boolean
  /** Only toggles the sidebar shortcut; Automations stay reachable from Settings/View menu. */
  showAutomationsButton?: boolean
  /** Only toggles the sidebar shortcut; Orca Mobile stays reachable from Settings. */
  showMobileButton?: boolean
  /** Pinned workspaces show in one sidebar location by default; opt in to also show them in their natural groups. */
  showPinnedWorktreesInGroups?: boolean
  /** How Ctrl+Tab picks the next visible tab; optional (older profiles), readers default to MRU. */
  ctrlTabOrderMode?: CtrlTabOrderMode
  /** Orca-first keeps app shortcuts from TUIs; terminal-first is opt-in to let shell/TUI bindings win. */
  terminalShortcutPolicy?: TerminalShortcutPolicy
  /** Floating Workspace: global surface for terminal/browser/markdown tabs outside repo/worktree context. */
  floatingTerminalEnabled: boolean
  /** One-shot migration flag for the floating-workspace default-on rollout; after migration an explicit off sticks. */
  floatingTerminalDefaultedForAllUsers?: boolean
  /** Start dir for new floating-workspace terminal tabs; empty or '~' = home dir. */
  floatingTerminalCwd: string
  /** Picker-approved floating-workspace dirs reauthorized across restarts; renderer text alone must not populate this. */
  floatingTerminalTrustedCwds?: string[]
  /** One-shot migration marker for legacy floating workspace cwd trust grants. */
  floatingTerminalCwdMigratedToAppWorkspace?: boolean
  /** Where the Floating Workspace toggle is shown; defaults to the floating button for discoverability. */
  floatingTerminalTriggerLocation: FloatingTerminalTriggerLocation
  /** Legacy keyboard-shortcut overrides; new writes go to ~/.orca/keybindings.json, migrated once when present. */
  keybindings?: KeybindingOverrides
  diffDefaultView: 'inline' | 'side-by-side'
  diffWordWrap: boolean
  combinedDiffFileTreeVisibleByDefault: boolean
  /** Bot-marked comment-author logins (stored lowercased); escape hatch for review bots on regular accounts that defeat provider metadata/heuristics. */
  prBotAuthorOverrides: string[]
  notifications: NotificationSettings
  /** Countdown after a Claude agent goes idle showing time left before the prompt cache expires. */
  promptCacheTimerEnabled: boolean
  /** Prompt-cache TTL (ms); only 300000 (5 min standard) or 3600000 (1 hr, extended-TTL plans). */
  promptCacheTtlMs: number
  /** Why: durable main-owned pref so Orca can prepare shared ~/.codex before the renderer hydrates. */
  codexManagedAccounts: CodexManagedAccount[]
  activeCodexManagedAccountId: string | null
  activeCodexManagedAccountIdsByRuntime?: CodexManagedAccountRuntimeSelection
  /** Why: persist only per-account auth (not a CLAUDE_CONFIG_DIR swap) so switching accounts doesn't fork Claude's shared chat/session context. */
  claudeManagedAccounts: ClaudeManagedAccount[]
  activeClaudeManagedAccountId: string | null
  activeClaudeManagedAccountIdsByRuntime?: ClaudeManagedAccountRuntimeSelection
  /** Per-worktree shell history file so ArrowUp doesn't surface other worktrees' commands. Defaults to true. */
  terminalScopeHistoryByWorktree: boolean
  /** Kill switch for hidden terminal view parking: unmount long-hidden panes while a pane-less watcher keeps PTY side effects alive. */
  terminalHiddenViewParking?: boolean
  /** Kill switch for main-process PTY side-effect authority; on (default) = title/bell/agent facts via pty:sideEffect channel, not renderer byte parsing. */
  terminalMainSideEffectAuthority?: boolean
  /** Kill switch for main's hidden-delivery gate (Phase 4): drops PTY bytes to hidden views after model ingestion; requires terminalMainSideEffectAuthority. */
  terminalHiddenDeliveryGate?: boolean
  /** Kill switch for main's model query responder (Phase 5); active only when both Phase-4 gates are also on. */
  terminalModelQueryAuthority?: boolean
  /** Which agent to pre-select in the new-workspace composer.
   *  - null: auto (first detected agent)
   *  - 'blank': blank terminal (no agent launched)
   *  - TuiAgent: a specific agent id */
  defaultTuiAgent: TuiAgent | 'blank' | null
  /** Agents hidden from picker/auto-launch; detection stays a raw PATH snapshot. */
  disabledTuiAgents: TuiAgent[]
  /** One-shot guard: start Claude Agent Teams hidden for existing profiles without overriding later opt-ins. */
  claudeAgentTeamsDefaultDisabledMigrated?: boolean
  /** Why: worktree deletion is destructive (rm -rf of the working dir), so confirm by default. */
  skipDeleteWorktreeConfirm: boolean
  /** Why: closing a terminal with child processes kills foreground work; keep this skip separate from other confirmations. */
  skipCloseTerminalWithRunningProcessConfirm: boolean
  /** Why: deleting an automation also deletes its run history; keep this skip separate from worktree deletion. */
  skipDeleteAutomationConfirm: boolean
  /** Why: a Codex rate-limit reset spends a scarce credit on the live account; keep this skip separate from local confirmations. */
  skipCodexRateLimitResetConfirm: boolean
  /** Default preset in the new-workspace GitHub task view. */
  defaultTaskViewPreset: TaskViewPresetId
  /** Persisted last-used task source so Tasks reopens to the same provider instead of defaulting to GitHub. */
  defaultTaskSource: TaskProvider
  /** Persisted visible task providers; hides unused providers from Tasks chrome and sidebar shortcuts. */
  visibleTaskProviders: TaskProvider[]
  /** Why: one-shot guard to make Jira visible for existing profiles once, without re-adding after a later opt-out. */
  visibleTaskProvidersDefaultedForJira: boolean
  /** Persisted repo selection (cross-repo tasks view). null = sticky-all (includes future-added repos);
   *  string[] = frozen curated subset (ineligible ids dropped on load; empty after drop is treated as null). */
  defaultRepoSelection: string[] | null
  /** Persisted Linear team selection (tasks view). Same nullable-array pattern as
   *  defaultRepoSelection: null = sticky-all, string[] = frozen subset of team IDs. */
  defaultLinearTeamSelection: string[] | null
  /** Session cookie for OpenCode Go rate-limit fetching. Stored encrypted. */
  opencodeSessionCookie: string
  /** Optional OpenCode Go workspace ID override; when set, skips the workspaces lookup and fetches usage directly. */
  opencodeWorkspaceId: string
  /** Optional MiniMax group id. When empty, the usage fetcher extracts minimax_group_id_v2 from the cookie. */
  minimaxGroupId: string
  /** Comma-separated MiniMax model names to show in the status bar usage window. */
  minimaxUsageModels: string
  /** Extract OAuth credentials from the local Gemini CLI for rate-limit fetching. Off by default (explicit opt-in). */
  geminiCliOAuthEnabled: boolean
  /** Per-agent CLI command overrides. A missing key means use the catalog default binary name. */
  agentCmdOverrides: Partial<Record<TuiAgent, string>>
  /** Custom CODEX_HOME for Codex session-history discovery (defaults to ~/.codex).
   *  History-only: does not change which account/config/hooks Orca uses. */
  codexSessionSourceHome?: {
    /** Absolute host path; empty/undefined falls back to ~/.codex. */
    host?: string
    /** Per-WSL-distro absolute Linux path; missing distro falls back to <wslHome>/.codex. */
    wsl?: Record<string, string>
  }
  /** Per-agent default CLI arguments appended after the binary/path and before prompts. */
  agentDefaultArgs?: Partial<Record<TuiAgent, string>>
  /** Per-agent launch environment defaults used when yolo mode is exposed as env. */
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
  /** One-shot guard for adding yolo-mode default args to untouched agent launch profiles. */
  agentYoloDefaultsMigrated?: boolean
  /** Why: disabling must persist so startup doesn't reinstall global agent hook entries the user just removed. */
  agentStatusHooksEnabled: boolean
  /** Dismissed freshness tuples: no write authority, just suppress re-nudging the same official placement/revision. */
  dismissedSkillFreshnessNudges?: string[]
  /** Why: generated tab titles are subjective, so they stay opt-in and manual renames win. */
  tabAutoGenerateTitle: boolean
  /** Why: pinned tabs can still be closed via keyboard/native-menu; this gates that behind a confirmation. Defaults on. */
  confirmClosePinnedTab: boolean
  /** When true, Orca requests local awake assertions while hook-reported agents are working. */
  keepComputerAwakeWhileAgentsRun: boolean
  /** macOS Option key: compose layout chars (@ German, € French) vs act as Meta/Esc for readline.
   *  'auto' (default) = layout-aware via navigator.keyboard.getLayoutMap() (US → Meta, else compose);
   *  'false' = compose; 'true' = Meta on both Option keys; 'left'/'right' = only that key is Meta.
   *  See docs/terminal-option-key-layout-aware-default.md. */
  terminalMacOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right'
  /** One-shot migration guard for the 'auto' rollout. Old default 'true' was ambiguous (explicit vs default);
   *  on first upgrade launch, reset a persisted 'true' to 'auto' so non-US keyboards aren't broken by the stale default. */
  terminalMacOptionAsAltMigrated: boolean
  /** Whether macOS terminal input maps the physical JIS Yen (¥) key to backslash, per common terminal expectation. */
  terminalJISYenToBackslash: boolean
  experimentalMobile: boolean
  /** Why: iOS Simulator is default-on for capable macOS hosts; this is the durable off switch (hides UI, blocks CLI attach). */
  mobileEmulatorEnabled?: boolean
  /** Preferred iOS Simulator UDID for UI auto-attach and agent CLI attach. */
  mobileEmulatorDefaultDeviceUdid?: string | null
  /** Explicit Android SDK root for when auto-discovery (ANDROID_HOME / default path) fails; null (default) auto-discovers. */
  androidSdkPath?: string | null
  /** Auto-restore window (ms) for a phone-fit PTY after the last mobile subscriber leaves.
   *  `null` (default) holds phone size indefinitely; a finite value schedules restore.
   *  Clamped on read to [5_000ms, 60min]. See docs/mobile-fit-hold.md. */
  mobileAutoRestoreFitMs: number | null
  /** Preferred mobile pairing path for new QR codes. Missing/'automatic' = Anywhere (Relay + local);
   *  explicit 'local-only' = same-network only. */
  mobilePairingConnectionMode?: 'automatic' | 'local-only'
  /** Experimental: floating animated pet in the bottom-right corner. Opt-in cosmetic;
   *  off never mounts the overlay, and toggling takes effect instantly (renderer-side). */
  experimentalPet: boolean
  /** Legacy persisted key from before the sidekick -> pet rename; read only during migration, new writes use experimentalPet. */
  experimentalSidekick?: boolean
  /** Experimental: left-sidebar Agents view — threaded feed of agent completions, blocking/unread state, worktree creation. */
  experimentalActivity: boolean
  /** Experimental: pop-out Kanban dashboard for monitoring and opening agent terminals across worktrees. */
  experimentalAgentDashboardPopout?: boolean
  /** One-shot migration guard for defaulting the Agents view off; later explicit opt-ins persist normally. */
  experimentalActivityDefaultedOffForAllUsers?: boolean
  /** Experimental: persistent terminal-pane attention ring for bell + agent-completion events. Opt-in while tuning signal/noise. */
  experimentalTerminalAttention: boolean
  /** Experimental: automatically sleep completed, resumable background agent terminals. */
  experimentalAgentHibernation?: boolean
  /** Milliseconds a completed agent must stay idle before hibernation can be considered. */
  agentHibernationIdleMs?: number
  /** Experimental: opt-in preview of the updated worktree-card layout and metadata behavior. */
  experimentalNewWorktreeCardStyle?: boolean
  /** Experimental: per-workspace on-demand environment recipes and setup surface. */
  experimentalEphemeralVms?: boolean
  /** Compact worktree cards: hide the metadata row when title and branch say the same thing. */
  compactWorktreeCards: boolean
  /** Legacy persisted key from the Experimental rollout; new writes use compactWorktreeCards. */
  experimentalCompactWorktreeCards?: boolean
  /** Active non-local runtime environment for client-routed RPC; null keeps local desktop behavior. */
  activeRuntimeEnvironmentId?: string | null
  /** GitHub Project mode state (pinned/recent/active project, last view per project).
   *  Optional for pre-feature profiles; the persistence merge hydrates the default. */
  githubProjects?: GitHubProjectSettings
  /** AI commit-message config (agent, model, per-model thinking, prompt suffix). Optional to avoid migrating existing profiles. */
  commitMessageAi?: CommitMessageAiSettings
  /** Source-control AI generation settings for commit messages and hosted-review drafts. */
  sourceControlAi?: SourceControlAiSettings
  /** GitLab project preferences (pinned + recent paths). Optional for pre-GitLab profiles; persistence merge fills the default. */
  gitlabProjects?: GitLabProjectSettings
  /** Anonymous product-telemetry state; optional until the one-shot Store.load() migration populates it.
   *  Holds only consent + identity, not volatile counters — those would amplify the debounced settings write. */
  telemetry?: {
    /** New users: true at install. Existing users: null until they resolve the first-launch banner. */
    optedIn: boolean | null
    /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
    installId: string
    /** Cohort marker: true for pre-existing profiles (gates the opt-in banner), false for fresh installs. */
    existedBeforeTelemetryRelease: boolean
  }
  /** One-shot cohort marker for the tab-switch keybinding swap. 'pending' =
   *  pre-existing install (seed pins old chords, then flips to 'done'); 'done' = fresh install. */
  tabSwitchKeybindingSeed?: 'pending' | 'done'
  /** Local voice/dictation config. Optional for pre-voice profiles; getDefaultSettings() hydrates defaults via the persistence merge. */
  voice?: VoiceSettings
}

export type OrcaWorkspaceLayout = {
  path: string
  nestWorkspaces: boolean
}

export type CommitMessageAiModelCapability = {
  id: string
  label: string
  thinkingLevels?: { id: string; label: string }[]
  defaultThinkingLevel?: string
}

export type CommitMessageAiSettings = {
  enabled: boolean
  /** A TuiAgent id, the literal `'custom'` for a user-supplied command, or null. */
  agentId: TuiAgent | 'custom' | null
  /** Per-agent: switching agents preserves the previously-picked model. */
  selectedModelByAgent: Partial<Record<TuiAgent, string>>
  /** Host-scoped model selections; dynamic agents can expose different models per SSH target. */
  selectedModelByAgentByHost?: Partial<Record<string, Partial<Record<TuiAgent, string>>>>
  /** Per-agent dynamic models last discovered from the CLI, persisted so main can validate selections. */
  discoveredModelsByAgent?: Partial<Record<TuiAgent, CommitMessageAiModelCapability[]>>
  /** Host-scoped dynamic model discovery cache. */
  discoveredModelsByAgentByHost?: Partial<
    Record<string, Partial<Record<TuiAgent, CommitMessageAiModelCapability[]>>>
  >
  /** Per-model: thinking effort depends on the model, not the agent. Keyed by model id. */
  selectedThinkingByModel: Record<string, string>
  /** Optional user-provided suffix appended to the base prompt (style overrides, etc.). */
  customPrompt: string
  /** Command template for agentId === 'custom'; {prompt} substitutes the diff prompt via argv, else the prompt is piped via stdin. */
  customAgentCommand: string
}

export type GhosttyImportPreview = {
  found: boolean
  configPath?: string
  configPaths?: string[]
  diff: Partial<GlobalSettings>
  unsupportedKeys: string[]
  error?: string
}

// Subset of onboarding Ghostty DiscoveryState statuses that emit telemetry; UI-only 'idle'/'detecting' don't.
export type DiscoveryStatusEmitted = 'found' | 'absent' | 'imported'

export type NotificationEventSource = 'agent-task-complete' | 'terminal-bell' | 'test'

export type NotificationDispatchRequest = {
  source: NotificationEventSource
  notificationId?: string
  /** Why: useful for fast native failures, but macOS can still drop notifications after 'show'. */
  requireDisplayConfirmation?: boolean
  worktreeId?: string
  /** Stable `${tabId}:${leafId}` terminal pane key for click-to-focus routing. */
  paneKey?: string
  repoLabel?: string
  worktreeLabel?: string
  hasMultipleActiveRepos?: boolean
  terminalTitle?: string
  isActiveWorktree?: boolean
  agentType?: AgentType
  agentState?: AgentStatusState
  agentPrompt?: string
  agentToolName?: string
  agentToolInput?: string
  agentLastAssistantMessage?: string
  agentInterrupted?: boolean
}

export type NotificationDispatchResult = {
  delivered: boolean
  /** Why delivery was skipped (set when delivered is false); 'blocked-by-system' = macOS would silently swallow it. */
  reason?:
    | 'disabled'
    | 'source-disabled'
    | 'suppressed-focus'
    | 'cooldown'
    | 'not-supported'
    | 'not-displayed'
    | 'blocked-by-system'
}

export type NotificationDismissResult = {
  dismissed: number
}

export type NotificationSoundResult = {
  played: boolean
  reason?:
    | 'missing-path'
    | 'invalid-path'
    | 'unsupported-type'
    | 'too-large'
    | 'read-failed'
    | 'playback-failed'
    | 'deduped'
}

export type NotificationSoundDataResult =
  | {
      ok: true
      data: Uint8Array
      mimeType: string
      path: string
    }
  | {
      ok: false
      reason: Exclude<NotificationSoundResult['reason'], 'playback-failed'>
    }

export type NotificationSoundPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing-path' | 'invalid-path' | 'unsupported-type' }

export type OnboardingOutcome = 'completed' | 'dismissed'

export type OnboardingChecklistState = {
  addedRepo: boolean
  choseAgent: boolean
  ranFirstAgent: boolean
  ranSecondAgentOnSameTask: boolean
  triedCmdJ: boolean
  shapedSidebar: boolean
  reviewedDiff: boolean
  openedPr: boolean
  addedFolder: boolean
  openedFile: boolean
  ranAgentOnFile: boolean
  // Why: UI state flag (panel visibility), not an activation event; telemetry checklist enum omits it.
  dismissed: boolean
}

export type OnboardingState = {
  // Why: step meanings change when pages are removed; version marker prevents migration re-running on new progress.
  flowVersion: number
  closedAt: number | null
  outcome: OnboardingOutcome | null
  // Sentinel -1 = not started; 1..5 = highest finished wizard step. number (not union) because callers clamp via Math.max/min.
  lastCompletedStep: number
  checklist: OnboardingChecklistState
}

export type NotificationPermissionStatusResult = {
  supported: boolean
  platform: NodeJS.Platform
  requested: boolean
}

/** macOS notification permission outcome: authoritative native UNUserNotificationCenter readout, else a weaker
 *  delivery-probe fallback; 'awaiting-decision' = permission dialog unanswered. */
export type NotificationDeliveryProbeResult = {
  state: 'delivered' | 'blocked' | 'awaiting-decision' | 'unsupported'
  /** True when the state comes from the native authorization readout (vs. the delivery-probe fallback). */
  authoritative: boolean
}

export type WorktreeCardProperty =
  | 'status'
  | 'unread'
  // Legacy persisted preference. CI status is now represented by linked PR metadata.
  | 'ci'
  // Migration-only: legacy detailed cards showed branch identity as a visible row.
  | 'branch'
  // Task metadata on workspace cards; provider-specific persisted values kept for older profiles.
  | 'issue'
  | 'linear-issue'
  | 'pr'
  | 'automation'
  | 'comment'
  | 'ports'
  // Inline agent-activity list rendered in each workspace card; on by default (see DEFAULT_WORKTREE_CARD_PROPERTIES in shared/constants.ts).
  | 'inline-agents'

export type WorktreeCardMode = 'Default' | 'Compact'

export type AgentActivityDisplayMode = 'compact' | 'full'

export type StatusBarItem =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'opencode-go'
  | 'kimi'
  | 'minimax'
  | 'grok'
  | 'ssh'
  | 'resource-usage'
  | 'ports'
export type FloatingTerminalTriggerLocation = 'floating-button' | 'status-bar'

export type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: TaskViewPresetId | null
  githubItemsQuery?: string
  githubProjectHiddenFieldIdsByView?: Record<string, string[]>
  linearMode?: 'issues' | 'projects' | 'views'
  linearPreset?: 'assigned' | 'created' | 'all' | 'completed'
  linearQuery?: string
  linearContext?: {
    kind: 'project' | 'view'
    id: string
    workspaceId: LinearConcreteWorkspaceId
    model?: LinearCustomViewModel
  }
  jiraPreset?: 'assigned' | 'reported' | 'all' | 'done'
  jiraQuery?: string
}

export type RightSidebarTab =
  | 'explorer'
  | 'search'
  | 'vault'
  | 'workspaces'
  | 'pr-checks'
  | 'source-control'
  | 'checks'
  | 'ports'
export type ActiveRightSidebarTab = Exclude<RightSidebarTab, 'search'>
export type RightSidebarExplorerView = 'files' | 'search'

export type ProjectOrderBy = 'manual' | 'recent'
export type WorkspaceHostScope = 'all' | 'local' | `ssh:${string}` | `runtime:${string}`
export type VisibleWorkspaceHostIds = Exclude<WorkspaceHostScope, 'all'>[] | null
export type WorkspaceHostOrder = Exclude<WorkspaceHostScope, 'all'>[]
export type ManualRepoOrderEntry = {
  hostId: WorkspaceHostOrder[number]
  repoId: string
}

/** The active top-level section shown in the main content area. */
export type TopLevelView =
  | 'terminal'
  | 'settings'
  | 'tasks'
  | 'activity'
  | 'automations'
  | 'space'
  | 'skills'
  | 'mobile'

export type PersistedUIState = {
  lastActiveRepoId: string | null
  lastActiveWorktreeId: string | null
  /** Active top-level view at save time, restored on relaunch; sanitized to 'terminal' if unknown or now-gated. */
  activeView: TopLevelView
  sidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarTab: RightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarWidth: number
  markdownTocPanelWidth?: number
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  /** Project header ordering in `groupBy: 'repo'`, independent of `sortBy`: 'manual' uses persisted order + header drag, 'recent' by latest visible activity. */
  projectOrderBy: ProjectOrderBy
  /** Deprecated; the Active only filter is retired and ignored on hydration. */
  showActiveOnly: boolean
  /** Hide sleeping/inactive workspaces from workspace navigation. Off by default. */
  hideSleepingWorkspaces?: boolean
  /** Which execution hosts the sidebar shows; `all` = mixed view, specific IDs focus without tearing down other hosts' sessions. */
  workspaceHostScope?: WorkspaceHostScope
  /** Which execution hosts the sidebar shows; `null` = sticky all-hosts so new hosts appear automatically. */
  visibleWorkspaceHostIds?: VisibleWorkspaceHostIds
  /** User-defined sidebar order for host sections; missing/new hosts append in discovered order. */
  workspaceHostOrder?: WorkspaceHostOrder
  /** Desktop-owned all-host repo order; host-qualified identities keep a manual cross-host interleaving while each host owns its local permutation. */
  manualRepoOrder?: ManualRepoOrderEntry[]
  /** Deprecated legacy positive-form setting. Ignored on hydration. */
  showSleepingWorkspaces?: boolean
  /** Deprecated legacy name used by a short-lived build. Ignored on hydration. */
  showInactiveWorkspaces?: boolean
  /** Hide the repo's checked-out branch from workspace nav (sidebar, Cmd+J); folder-mode repos are unaffected (empty-branch worktrees excluded). */
  hideDefaultBranchWorkspace: boolean
  /** Hide workspaces created by automation new-per-run dispatches. */
  hideAutomationGeneratedWorkspaces?: boolean
  /** Per-worktree Explorer dotfile visibility. Missing entries inherit the default: show. */
  showDotfilesByWorktree?: Record<string, boolean>
  filterRepoIds: string[]
  collapsedGroups: string[]
  uiZoomLevel: number
  editorFontZoomLevel: number
  worktreeCardProperties: WorktreeCardProperty[]
  /** One-shot migration flag for deriving card properties from the two worktree card modes. */
  _worktreeCardModeDefaulted?: boolean
  agentActivityDisplayMode?: AgentActivityDisplayMode
  workspaceStatuses?: WorkspaceStatusDefinition[]
  workspaceBoardOpacity?: number
  workspaceBoardColumnWidth?: number
  syncTaskStatusFromWorkspaceBoard?: boolean
  /** One-shot migration flag for a short-lived build that persisted default statuses in reverse order; once stamped, ordering is never re-inferred from IDs/labels. */
  _workspaceStatusesDefaultOrderMigrated?: boolean
  /** One-shot repair flag for the exact default payload a short-lived build persisted in reverse workflow order. */
  _workspaceStatusesReorderedDefaultRepaired?: boolean
  /** One-shot migration flag for default status workflow labels/visuals; only exact legacy defaults migrate, customized statuses preserved. */
  _workspaceStatusesDefaultWorkflowMigrated?: boolean
  /** One-shot migration flag for the old default status visuals; once stamped, user-authored colors/icons are preserved. */
  _workspaceStatusesDefaultVisualsMigrated?: boolean
  /** One-shot migration flag for adding the default-on Ports status item. */
  _portsStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Kimi status item. */
  _kimiStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on MiniMax status item. */
  _minimaxStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Antigravity status item. */
  _antigravityStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Grok status item. */
  _grokStatusBarDefaultAdded?: boolean
  statusBarItems: StatusBarItem[]
  statusBarVisible: boolean
  /** Why: this is client-side presentation, not a provider/account or execution-host setting. */
  usagePercentageDisplay?: UsagePercentageDisplay
  /** Client-side footer presentation; verbose preserves the pre-roster all-window default. */
  statusBarUsageMode?: StatusBarUsageMode
  dismissedUpdateVersion: string | null
  lastUpdateCheckAt: number | null
  pendingUpdateNudgeId?: string | null
  dismissedUpdateNudgeId?: string | null
  /** Whether Orca already tried triggering the macOS notification permission dialog; prevents re-firing every launch. */
  notificationPermissionRequested?: boolean
  /** Once the "your sessions won't be interrupted" reassurance card is seen, never show it again. */
  updateReassuranceSeen?: boolean
  /** Per-paneKey "row visited" timestamps that mute seen inline-agent rows; persisted because rows survive restart, else acked rows return bold. Renderer-owned via ui:set. */
  acknowledgedAgentsByPaneKey?: Record<string, number>
  /** User-hidden setup-guide sidebar entry; a reversible declutter pref (Help menu stays available), not completion. */
  setupGuideSidebarDismissed?: boolean
  /** One-shot marker for the browser setup-guide milestone; profiles missing it are evaluated once in the renderer (completion needs runtime probes). */
  setupGuideBrowserMilestoneMigrated?: boolean
  /** Existing users who completed/dismissed the pre-browser checklist stay complete after the browser milestone is added. */
  setupGuideBrowserMilestoneLegacyComplete?: boolean
  /** User-dismissed browser import toolbar hint; import stays available from Settings > Browser and the overflow menu. */
  browserImportHintHidden?: boolean
  /** Why: Windows-only. Set once on first hide to tray so the "Orca is still running" notice shows only once. */
  trayMinimizeNoticeShown?: boolean
  /** User dismissed the first-run Mobile Emulator intro; reversible only by re-enabling the feature in Settings. */
  mobileEmulatorTabIntroDismissed?: boolean
  /** User deferred the in-pane Mobile Emulator CLI + skill setup guide. */
  mobileEmulatorAgentSetupDismissed?: boolean
  /** One-shot rollout notice for manual project ordering default; absent or true keeps the sidebar callout hidden. */
  projectOrderManualDefaultNoticeDismissed?: boolean
  /** One-shot notice that usage meters show percent used, not remaining; absent resolves on load (new profiles dismissed, upgraded see it once). */
  usagePercentageDisplayChangeNoticeDismissed?: boolean
  /** User-hidden empty-state usage CTA; permanently hides the "Connect AI accounts" prompt even if providers are later disconnected. */
  usageEmptyStateDismissed?: boolean
  /** URL for new browser tabs; null = blank tab. */
  browserDefaultUrl?: string | null
  browserDefaultSearchEngine?: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  /** Electron browser zoom level applied when a new local browser tab is created. */
  browserDefaultZoomLevel?: number
  /** Optional Kagi private-session link used only when Kagi is the search engine. */
  browserKagiSessionLink?: string | null
  /** Saved window bounds so the app restores last position/size instead of maximizing each launch. */
  windowBounds?: { x: number; y: number; width: number; height: number } | null
  /** Whether the window was maximized when it was last closed. */
  windowMaximized?: boolean
  /** Saved bounds for the pop-out dashboard window so it restores to its last
   *  position/size. Independent of the main window's bounds. */
  dashboardPopoutBounds?: { x: number; y: number; width: number; height: number } | null
  /** One-shot flag: 'recent' once meant the smart sort (v1→v2 rename), migrated to 'smart' once so the new last-activity 'recent' isn't re-clobbered. */
  _sortBySmartMigrated?: boolean
  /** LEGACY inline-agents flag, stamped unconditionally every load so it can't gate migration; kept only for rollback forward-compat (real gate: _inlineAgentsDefaultedForAllUsers). */
  _inlineAgentsDefaultedForExperiment?: boolean
  /** One-shot flag for the inline-agents default-on rollout; distinct from _inlineAgentsDefaultedForExperiment, which was stamped every load and is permanently dirty. */
  _inlineAgentsDefaultedForAllUsers?: boolean
  /** One-shot migration flag for split-out card properties, set once so later deliberate unchecks of Linear issue/Ports stick across restarts. */
  _expandedWorktreeCardPropertiesDefaulted?: boolean
  /** totalAgentsSpawned snapshot at first sighting of the current app version, so the nag counts agents since last update (not from zero). */
  starNagBaselineAgents?: number | null
  /** App version that set the current baseline; a version change re-captures the baseline on next spawn, restarting the nag countdown. */
  starNagAppVersion?: string | null
  /** Next agents-since-baseline threshold that fires the star-nag; starts at 35, doubles per dismissal without starring. */
  starNagNextThreshold?: number
  /** Once the user has starred Orca (any entry point), permanently suppress the nag. */
  starNagCompleted?: boolean
  /** Timestamp until which nonterminal dismissals suppress threshold prompts (force-show bypasses for dev/testing). */
  starNagDeferredUntil?: number | null
  /** App version that consumed the first value-moment ask; main-owned so remote/web clients can't spoof the once-per-version cap. */
  starNagAgentValueMomentAppVersion?: string | null
  trustedOrcaHooks?: PersistedTrustedOrcaHooks
  setupScriptPromptDismissedRepoIds?: string[]
  /** Pet overlay visibility, separate from the experimentalPet settings flag so "Hide pet" is a reversible dismiss; absent = true. */
  petVisible?: boolean
  /** Active pet id (bundled id or custom UUID); unknown ids fall back to the default on read so a removed custom pet doesn't blank the overlay. */
  petId?: string
  /** Metadata index for user-uploaded pet images; bytes live under legacy userData/sidekicks/custom/. */
  customPets?: CustomPet[]
  /** Pet overlay size in CSS pixels (square); clamped to [PET_SIZE_MIN, PET_SIZE_MAX] on read. */
  petSize?: number
  /** Legacy keys from before the sidekick -> pet rename; read only during migration, new writes use pet* above. */
  sidekickVisible?: boolean
  sidekickId?: string
  customSidekicks?: CustomPet[]
  sidekickSize?: number
  /** Page-position state for Tasks: only transient tabs/searches (source/repo/team/project selections use their own settings paths). */
  taskResumeState?: TaskResumeState
  workspaceCleanup?: WorkspaceCleanupUIState
  /** Feature tips already surfaced; startup opens the tips modal only when a current tip id is missing here. */
  featureTipsSeenIds?: FeatureTipId[]
  /** Feature ids the user has actually used; education surfaces skip teaching already-discovered features. */
  featureInteractions?: FeatureInteractionState
  /** Contextual tours already surfaced; unknown ids ignored on hydration for downgrade/upgrade forward-compat. */
  contextualToursSeenIds?: ContextualTourId[]
  /** Whether this profile may receive automatic contextual tours; missing = renderer hasn't classified the profile yet. */
  contextualToursAutoEligible?: boolean
}

export const PET_SIZE_MIN = 60
export const PET_SIZE_MAX = 360
export const PET_SIZE_DEFAULT = 180

/** User-uploaded pet image metadata; renderer fetches bytes from main via pet:read (id, fileName), never learning the on-disk path. */
export type CustomPet = {
  id: string
  label: string
  fileName: string
  /** MIME type for the renderer's Blob Content-Type — esp. image/svg+xml, which browsers won't render from a misdeclared blob URL. */
  mimeType: string
  /** Storage layout: `image` = legacy flat file `custom/<id>.<ext>`; `bundle` = `.codex-pet` expanded into `custom/<id>/`; absent = legacy `image`. */
  kind?: 'image' | 'bundle'
  /** Sprite-sheet metadata; present iff from a `.codex-pet` bundle with a manifest frame layout. Dims derived in main so the renderer needn't probe the image. */
  sprite?: {
    frameWidth: number
    frameHeight: number
    columns: number
    rows: number
    sheetWidth: number
    sheetHeight: number
    fps: number
    defaultAnimation?: string
    animations?: Record<string, SpriteAnimation>
  }
  /** Manifest-declared fps kept even when frames are auto-detected, so playback honors the bundle's speed instead of a hardcoded 8 fps. */
  spriteFps?: number
}

/** One animation strip in a sprite sheet: `row` = 0-based y-index, `frames` = consecutive cells played left-to-right. */
export type SpriteAnimation = {
  row: number
  frames: number
  /** Per-frame holds in ms (length === frames). Absent means uniform sheet fps. */
  frameDurationsMs?: number[]
}

export type PersistedTrustedOrcaHookEntry = {
  contentHash: string
  approvedAt: number
}

export type PersistedTrustedOrcaHookRepo = {
  all?: {
    approvedAt: number
  }
  setup?: PersistedTrustedOrcaHookEntry
  archive?: PersistedTrustedOrcaHookEntry
  issueCommand?: PersistedTrustedOrcaHookEntry
  vmRecipe?: PersistedTrustedOrcaHookEntry
}

export type PersistedTrustedOrcaHooks = Record<string, PersistedTrustedOrcaHookRepo>

export type LegacyPaneKeyAliasEntry = {
  ptyId: string
  /** Physical pane key retained by the live process; name is persisted for compatibility (UUID keys after detach). */
  legacyPaneKey: string
  /** Current logical owner pane key. May belong to another tab after detach. */
  stablePaneKey: string
  updatedAt: number
}

// ─── Persistence shape ──────────────────────────────────────────────
export type PersistedState = {
  schemaVersion: number
  repos: Repo[]
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  /** Sparse-checkout presets keyed by repoId. */
  sparsePresetsByRepo: Record<string, SparsePreset[]>
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
  /** Live local Claude daemon session ids; seeds the live-PTY gate so early OAuth refresh can't rotate the single-use refresh token out from under a running daemon. */
  claudeLivePtySessionIds?: string[]
  migrationUnsupportedPtyEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
  automations: Automation[]
  automationRuns: AutomationRun[]
  onboarding: OnboardingState
  /** Main-owned telemetry de-dupe marker; never exposed through PersistedUIState. */
  featureInteractionTelemetryBuckets?: FeatureInteractionTelemetryBucketState
}

// ─── Filesystem ─────────────────────────────────────────────
export type DirEntry = {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

export type MarkdownDocument = {
  filePath: string
  relativePath: string
  basename: string
  name: string
}

// ─── Filesystem watcher ─────────────────────────────────────
export type FsChangeEvent = {
  kind: 'create' | 'update' | 'delete' | 'rename' | 'overflow'
  absolutePath: string
  oldAbsolutePath?: string
  isDirectory?: boolean
}

export type FsChangedPayload = {
  worktreePath: string
  events: FsChangeEvent[]
}

// ─── Git Status ─────────────────────────────────────────────
// Re-exported from git-status-types.ts so mobile shares the wire contract without this desktop aggregate.

export type GitBranchChangeEntry = {
  path: string
  status: GitBranchChangeStatus
  oldPath?: string
  added?: number
  removed?: number
}

export type GitBranchCompareSummary = {
  baseRef: string
  baseOid: string | null
  compareRef: string
  headOid: string | null
  mergeBase: string | null
  changedFiles: number
  commitsAhead?: number
  status: 'ready' | 'invalid-base' | 'unborn-head' | 'no-merge-base' | 'loading' | 'error'
  errorMessage?: string
}

export type GitBranchCompareResult = {
  summary: GitBranchCompareSummary
  entries: GitBranchChangeEntry[]
}

export type GitCommitCompareSummary = {
  commitOid: string
  parentOid: string | null
  compareRef: string
  baseRef: string
  changedFiles: number
  status: 'ready' | 'invalid-commit' | 'error'
  errorMessage?: string
}

export type GitCommitCompareResult = {
  summary: GitCommitCompareSummary
  entries: GitBranchChangeEntry[]
}

export type GitDiffTextResult = {
  kind: 'text'
  originalContent: string
  modifiedContent: string
  originalIsBinary: false
  modifiedIsBinary: false
  largeDiffRenderLimit?: LargeDiffRenderLimit
}

export type GitDiffBinaryResult = {
  kind: 'binary'
  originalContent: string
  modifiedContent: string
  /** Legacy flag used by the renderer for any binary format it can preview, including PDFs. */
  isImage?: boolean
  /** MIME type for binary preview rendering, e.g. "image/png" or "application/pdf" */
  mimeType?: string
  /** True only for a proven deletion — distinct from an empty modified side caused by a read failure or size cap. */
  modifiedDeleted?: boolean
} & (
  | { originalIsBinary: true; modifiedIsBinary: boolean }
  | { originalIsBinary: boolean; modifiedIsBinary: true }
)

export type GitDiffResult = GitDiffTextResult | GitDiffBinaryResult

// ─── Search ─────────────────────────────────────────────
export type SearchMatch = {
  line: number
  column: number
  matchLength: number
  lineContent: string
  displayColumn?: number
  displayMatchLength?: number
}

export type SearchFileResult = {
  filePath: string
  relativePath: string
  matches: SearchMatch[]
  matchCount?: number
}

export type SearchResult = {
  files: SearchFileResult[]
  totalMatches: number
  truncated: boolean
}

export type SearchOptions = {
  query: string
  rootPath: string
  caseSensitive?: boolean
  wholeWord?: boolean
  useRegex?: boolean
  includePattern?: string
  excludePattern?: string
  maxResults?: number
}

// ─── Stats ──────────────────────────────────────────────────────────

export type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  // Sourced from aggregates, not the event log, so it survives event trimming.
  firstEventAt: number | null // timestamp of first-ever event, for "tracking since..."
}

// ─── Memory dashboard ──────────────────────────────────────────────

/** cpu is percent of a single core — can exceed 100 on multi-core. memory is in bytes. */
export type UsageValues = {
  cpu: number
  memory: number
}

/** The top-level cpu/memory are the sum of main + renderer + other. */
export type AppMemory = UsageValues & {
  main: UsageValues
  renderer: UsageValues
  other: UsageValues
  /** Oldest-first memory samples (bytes) for the whole Orca app; empty before the first snapshot. */
  history: number[]
}

export type SessionMemory = UsageValues & {
  sessionId: string
  paneKey: string | null
  pid: number
}

/** The top-level cpu/memory are the sum of sessions. */
export type WorktreeMemory = UsageValues & {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  sessions: SessionMemory[]
  /** Oldest-first memory samples (bytes) for this worktree's tracked subtrees. */
  history: number[]
}

export type HostMemory = {
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  cpuCoreCount: number
  loadAverage1m: number
}

export type MemorySnapshot = {
  app: AppMemory
  worktrees: WorktreeMemory[]
  host: HostMemory
  /** Sum of app + all tracked worktree sessions. Percent of a single core, so may exceed 100 on multi-core machines. */
  totalCpu: number
  /** Sum of app + all tracked worktree sessions in bytes. NOT the same as host.totalMemory, which is physical RAM. */
  totalMemory: number
  collectedAt: number
}
