/* eslint-disable max-lines */
import type { ExecutionHostId } from './execution-host'
import type { SshRemotePtyLease, SshTarget } from './ssh-types'
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
 * - `'mixed'`: list work items from origin AND upstream merged. Single-target
 *   operations (issue creation) resolve like `'auto'` — a new issue cannot be
 *   filed "in both".
 */
export type IssueSourcePreference = 'upstream' | 'origin' | 'auto' | 'mixed'
export type { ForkSyncMode, GitForkSyncExpectedUpstream, GitForkSyncResult } from './git-fork-sync'
export type { GitAddUpstreamRemoteResult } from './git-upstream-remote'
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
  /** Paths (relative to the primary checkout) that should be symlinked into
   *  newly created worktrees of this repo. Consumed only when the global
   *  `experimentalWorktreeSymlinks` flag is on — the per-repo list is the
   *  "what to link", the global flag is the "whether to link at all" switch.
   *  Undefined/empty means no symlinks are created for this repo. */
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
  /** True for the repo's main working tree (the first entry from `git worktree list`).
   *  Linked worktrees created via `git worktree add` have this set to false. */
  isMainWorktree: boolean
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

export type WorktreeOwnership = 'orca-managed' | 'external' | 'unknown-legacy'

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
  | 'tasks'

export type WorkspaceVisibleTabType = 'terminal' | 'editor' | 'browser' | 'simulator' | 'tasks'
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
  prRepo?: GitHubRepositoryIdentity
  headRepo?: GitHubRepositoryIdentity
  conflictSummary?: PRConflictSummary
}

export type PRRefreshOutcome =
  | { kind: 'found'; pr: PRInfo; fetchedAt: number }
  | { kind: 'no-pr'; fetchedAt: number }
  | {
      kind: 'upstream-error'
      errorType:
        | 'rate_limited'
        | 'auth'
        | 'network'
        | 'permission'
        | 'repo_unavailable'
        | 'gh_unavailable'
        | 'unknown'
      message: string
      fetchedAt: number
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
  /** Set only by the 'mixed' issue-source list merge: which remote of the
   *  fork the item came from. Absent under single-source preferences. */
  sourceRemote?: 'origin' | 'upstream'
  /** The owner/repo slug the item was listed from, set alongside
   *  `sourceRemote`. Lets rows and detail routing distinguish origin #5
   *  from upstream #5 without re-parsing `url`. */
  sourceOwnerRepo?: GitHubOwnerRepo
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
/** Highest permission tier the authenticated viewer holds on a repository,
 *  derived from the REST `permissions` flags. Drives read-only rendering of
 *  mutation affordances (state/labels/assignees) in the item dialog. */
export type GitHubViewerRepoPermission = 'admin' | 'maintain' | 'write' | 'triage' | 'read'

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
    /** `source` is the repo whose issues fetch failed. Set in 'mixed' mode,
     *  where `sources.issues` reports the auto-primary side and may differ
     *  from the failing side; absent on single-source lists. */
    issues?: ClassifiedError & { source?: GitHubOwnerRepo }
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

export type CodexRateLimitAccountsState = {
  accounts: CodexManagedAccountSummary[]
  activeAccountId: string | null
  activeAccountIdsByRuntime?: CodexManagedAccountRuntimeSelection
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
  /** Why: Windows-only. When on, the close (X) button hides the window to the
   *  system tray instead of quitting Orca; off keeps the default quit-on-close.
   *  The tray icon itself is always present on Windows regardless of this flag. */
  minimizeToTrayOnClose?: boolean
  /** Why: Windows terminals conventionally use right-click as a paste gesture.
   *  The setting stays Windows-only so macOS/Linux keep their existing context
   *  menu behavior and users can still reach the menu with Ctrl+right-click. */
  terminalRightClickToPaste: boolean
  /** Why: COMSPEC always points to cmd.exe on stock Windows, so without an
   *  explicit setting the terminal would always open CMD instead of the
   *  user's preferred shell. Defaults to 'powershell.exe' which is the
   *  modern choice for an IDE context. Only consulted on Windows. */
  terminalWindowsShell: string
  /** Why: when WSL is the Windows default shell, users with multiple distros
   *  need Orca to launch terminals and scan agents in the same chosen distro
   *  instead of whatever WSL currently marks as its global default. */
  terminalWindowsWslDistro?: string | null
  /** Why: account/auth location is independent from the user's preferred
   *  terminal shell. A user may default new terminals to WSL while still
   *  inspecting or adding Windows-scoped provider accounts. */
  localAccountRuntime: 'host' | 'wsl'
  localAccountWslDistro?: string | null
  /** Why: installed-agent detection is also a local environment choice. Keep
   *  it independent so users can inspect Windows and WSL PATH state without
   *  changing the default terminal shell. */
  localAgentRuntime?: 'host' | 'wsl'
  localAgentWslDistro?: string | null
  /** Why: global is only the default policy; project-level runtime preference wins. */
  localWindowsRuntimeDefault: GlobalWindowsRuntimeDefault
  /** Why: "PowerShell" is the product-facing shell family. Auto resolves to
   *  PowerShell 7+ when present and falls back to inbox Windows PowerShell. */
  terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
  terminalFocusFollowsMouse: boolean
  /** Why: mirrors X11 / gnome-terminal "copy on select" UX — making a terminal
   *  selection copies it to the system clipboard automatically, so users can
   *  paste with Cmd/Ctrl+V without an intervening Cmd/Ctrl+Shift+C. Defaults
   *  to false so existing users keep the explicit-copy behavior. */
  terminalClipboardOnSelect: boolean
  /** Why: lets TUIs like tmux, nvim, and fzf copy to the system clipboard via
   *  the OSC 52 escape sequence — essential for SSH-hosted workflows where
   *  the terminal is the only bridge to the local clipboard. Defaults to
   *  false because OSC 52 is a classic data-exfiltration vector (any
   *  process piping untrusted output into the terminal — `cat attacker.log`
   *  — can silently rewrite the user's clipboard). Opt-in preserves the
   *  conservative default while making the capability one toggle away. */
  terminalAllowOsc52Clipboard: boolean
  /** Experimental Claude Code Agent Teams integration. Native panes use a
   *  tmux-compatible shim so teammate output stays on Orca's normal PTY path. */
  claudeAgentTeamsMode?: ClaudeAgentTeamsMode
  /** Where the repo setup script runs on workspace create. Defaults to a
   *  background "Setup" tab so the user's main terminal stays immediately
   *  usable without the setup output crowding the initial pane. */
  setupScriptLaunchMode: SetupScriptLaunchMode
  terminalScrollbackRows: number
  /** Optional app-level proxy for Electron networking and locally spawned PTYs.
   *  Empty preserves system proxy settings plus inherited proxy env behavior. */
  httpProxyUrl?: string
  /** Optional semicolon/comma/newline-separated bypass rules for httpProxyUrl. */
  httpProxyBypassRules?: string
  /** Why: corporate TLS-intercepting proxies can break Electron HTTP/2 downloads;
   *  this opt-in compatibility mode applies Chromium's process-wide HTTP/1.1 switch. */
  electronHttp1CompatibilityMode?: boolean
  /** Why: opening arbitrary links inside Orca uses an isolated guest browser surface.
   *  The setting stays opt-in so existing workflows continue to use the system browser
   *  until the user explicitly wants worktree-scoped in-app browsing. */
  openLinksInApp: boolean
  /** Why: worktree-scoped localhost hostnames make same-app tabs distinguishable
   *  in external browsers. Opt-in (default off): serving the app under a different
   *  host can break dev apps that bind cookies/sessions to localhost. */
  localhostWorktreeLabelsEnabled?: boolean
  /** Why: terminal link routing asks once at first use instead of silently
   *  changing where links open for new users. */
  openLinksInAppPreferencePrompted: boolean
  /** Opt-in: open newly launched coding-agent tabs directly in the native chat
   *  view instead of the raw terminal. Off by default so existing workflows are
   *  unchanged. Optional for legacy-settings compatibility; defaults applied. */
  openAgentTabsInChatByDefault?: boolean
  /** Experimental: native chat surface for Claude/Codex terminal sessions.
   *  Off by default while the desktop UX is still being exercised. */
  experimentalNativeChat?: boolean
  /** Extra launcher rows for the worktree "Open in" submenu. VS Code is always shown first. */
  openInApplications?: OpenInApplication[]
  /** Deprecated: migration/backward-compat only. Use PersistedUIState.rightSidebarOpen. */
  rightSidebarOpenByDefault: boolean
  showGitIgnoredFiles?: boolean
  /** Preferred Source Control changes layout. Per-user, not per-workspace. */
  sourceControlViewMode: SourceControlViewMode
  /** Preferred Source Control group order. Per-user, not per-workspace. */
  sourceControlGroupOrder: SourceControlGroupOrder
  /** When enabled, the Source Control compare base defaults to the current
   *  branch's upstream (prioritizing local changes) instead of the repo
   *  default branch. Only affects the compare/diff view, not the PR/rebase
   *  merge target. Per-user, not per-workspace. */
  sourceControlCompareAgainstUpstream: boolean
  /** Whether to show the Orca app name in the titlebar. */
  showTitlebarAppName: boolean
  /** Why: some users do not use the Tasks feature and prefer to keep the
   *  left sidebar free of its button entirely. Hiding the button here also
   *  removes it from keyboard navigation. */
  showTasksButton: boolean
  /** Why: Automations can be restored from Settings or the View menu, so this
   *  only controls whether the top-level sidebar shortcut is shown. */
  showAutomationsButton?: boolean
  /** Why: Orca Mobile remains reachable from Settings; this only controls
   *  whether the top-level sidebar shortcut is shown. */
  showMobileButton?: boolean
  /** Controls how Ctrl+Tab chooses the next visible tab. Optional for
   *  profiles saved before this setting existed; readers default to MRU. */
  ctrlTabOrderMode?: CtrlTabOrderMode
  /** Why: Orca-first preserves fast workspace/app control from agent TUIs.
   *  Terminal-first is opt-in for users who want shell/TUI bindings to win. */
  terminalShortcutPolicy?: TerminalShortcutPolicy
  /** Why: Floating Workspace is the default global surface so users can
   *  reach terminal, browser, and markdown tabs outside repo/worktree context. */
  floatingTerminalEnabled: boolean
  /** One-shot migration flag for the default-on rollout. Before this field
   *  landed, the floating workspace defaulted off and many profiles persisted
   *  that inherited false. Once migrated, an explicit off choice sticks. */
  floatingTerminalDefaultedForAllUsers?: boolean
  /** Where new Floating Workspace terminal tabs start. Empty or '~' means
   *  the user's home directory; markdown notes use Orca's app-owned
   *  floating workspace under Electron userData. */
  floatingTerminalCwd: string
  /** Picker-approved Floating Workspace directories that may be reauthorized
   *  across restarts. Renderer-provided text alone must not populate this. */
  floatingTerminalTrustedCwds?: string[]
  /** One-shot migration marker for legacy floating workspace cwd trust grants. */
  floatingTerminalCwdMigratedToAppWorkspace?: boolean
  /** Where the Floating Workspace toggle is shown. Defaults to the floating
   *  button for discoverability. */
  floatingTerminalTriggerLocation: FloatingTerminalTriggerLocation
  /** Legacy pre-file-backed keyboard shortcut overrides. New writes go to
   *  ~/.orca/keybindings.json; main migrates this once when present. */
  keybindings?: KeybindingOverrides
  diffDefaultView: 'inline' | 'side-by-side'
  diffWordWrap: boolean
  combinedDiffFileTreeVisibleByDefault: boolean
  notifications: NotificationSettings
  /** When true, a countdown timer is shown after a Claude agent becomes idle,
   *  indicating time remaining before the prompt cache expires. Disabled by default. */
  promptCacheTimerEnabled: boolean
  /** Prompt-cache TTL in milliseconds. Only two values are supported:
   *  300 000 (5 min, the standard Anthropic API / Bedrock TTL) and
   *  3 600 000 (1 hr, for extended-TTL plans). */
  promptCacheTtlMs: number
  /** Why: Codex rate-limit account routing is a durable app preference owned by
   *  the main process, not transient UI state. Persisting the selected managed
   *  auth here lets Orca prepare shared ~/.codex before the renderer hydrates,
   *  while keeping this scope explicitly separate from Codex usage analytics
   *  and external terminal sessions. */
  codexManagedAccounts: CodexManagedAccount[]
  activeCodexManagedAccountId: string | null
  activeCodexManagedAccountIdsByRuntime?: CodexManagedAccountRuntimeSelection
  /** Why: Claude Code keeps conversations under one shared config root. Orca
   *  persists only per-account auth material here so switching accounts does
   *  not fork prior chat/session context the way CLAUDE_CONFIG_DIR swapping would. */
  claudeManagedAccounts: ClaudeManagedAccount[]
  activeClaudeManagedAccountId: string | null
  activeClaudeManagedAccountIdsByRuntime?: ClaudeManagedAccountRuntimeSelection
  /** When true, each worktree gets its own shell history file so ArrowUp
   *  does not surface commands from other worktrees. Defaults to true.
   *  Disable to revert to shared global shell history. */
  terminalScopeHistoryByWorktree: boolean
  /** Which agent to pre-select in the new-workspace composer.
   *  - null: auto (first detected agent)
   *  - 'blank': blank terminal (no agent launched)
   *  - TuiAgent: a specific agent id */
  defaultTuiAgent: TuiAgent | 'blank' | null
  /** Agents hidden from future picker and automatic launch choices. Detection
   *  remains a raw PATH capability snapshot. */
  disabledTuiAgents: TuiAgent[]
  /** One-shot guard so the experimental Claude Agent Teams launch mode starts
   *  hidden for existing profiles without overriding later user opt-ins. */
  claudeAgentTeamsDefaultDisabledMigrated?: boolean
  /** Why: worktree deletion is destructive (git worktree remove + rm -rf of the
   *  working directory), so Orca shows a confirmation dialog by default. Users
   *  who delete frequently can opt into skipping the dialog via a "Don't ask
   *  again" checkbox inside it or from the General settings pane. We keep this
   *  defaulted to false so first-time behavior stays safe. */
  skipDeleteWorktreeConfirm: boolean
  /** Why: closing a terminal with child processes kills foreground work. Keep
   *  this separate from other destructive confirmations so power users can speed
   *  up terminal cleanup without weakening workspace or automation safeguards. */
  skipCloseTerminalWithRunningProcessConfirm: boolean
  /** Why: deleting an automation also deletes its run history. Keep this
   *  separate from worktree deletion so skipping one destructive confirmation
   *  does not silently skip the other. */
  skipDeleteAutomationConfirm: boolean
  /** Why: Codex rate-limit resets consume a scarce reset credit and immediately
   *  affect the signed-in account, so keep the skip preference explicit and
   *  separate from local destructive-action confirmations. */
  skipCodexRateLimitResetConfirm: boolean
  /** Default preset in the new-workspace GitHub task view. */
  defaultTaskViewPreset: TaskViewPresetId
  /** Why: persists the user's last-used task source so the Tasks page
   *  reopens to the same provider instead of always defaulting to GitHub. */
  defaultTaskSource: TaskProvider
  /** Why: users may only work from one hosted task system. Persisting this
   *  list hides unused providers from Tasks chrome and sidebar shortcuts while
   *  leaving the chosen default source stable when it is still visible. */
  visibleTaskProviders: TaskProvider[]
  /** Why: one-shot migration guard so Jira becomes visible for existing
   *  profiles once, without re-adding it after a later deliberate opt-out. */
  visibleTaskProvidersDefaultedForJira: boolean
  /** Why: persists the user's repo selection in the cross-repo tasks view.
   *  `null` means sticky-all — every eligible repo is selected, including
   *  repos added in future sessions, so the "All repos" label stays
   *  truthful. An explicit array freezes the curated subset; ids no longer
   *  eligible are silently dropped on load. An empty array after that drop
   *  is treated as `null`. */
  defaultRepoSelection: string[] | null
  /** Why: persists the user's Linear team selection in the tasks view.
   *  Same nullable-array pattern as `defaultRepoSelection`: `null` = sticky-all,
   *  `string[]` = frozen subset of team IDs. */
  defaultLinearTeamSelection: string[] | null
  /** Session cookie for OpenCode Go rate-limit fetching. Stored encrypted. */
  opencodeSessionCookie: string
  /** Optional workspace ID override for OpenCode Go. When set, skips the
   *  workspaces lookup and fetches usage directly for this workspace. */
  opencodeWorkspaceId: string
  /** Optional MiniMax group id. When empty, the usage fetcher extracts minimax_group_id_v2 from the cookie. */
  minimaxGroupId: string
  /** Comma-separated MiniMax model names to show in the status bar usage window. */
  minimaxUsageModels: string
  /** Whether to extract OAuth credentials from the local Gemini CLI installation
   *  for rate-limit fetching. Disabled by default for explicit opt-in. */
  geminiCliOAuthEnabled: boolean
  /** Per-agent CLI command overrides. A missing key means use the catalog default binary name. */
  agentCmdOverrides: Partial<Record<TuiAgent, string>>
  /** Why: Orca bridges Codex session history from the user's real Codex home into
   *  its managed home so /resume finds it, but defaults to ~/.codex. Users who run
   *  Codex with a custom CODEX_HOME can point history discovery at that folder here.
   *  History-only: this does not change which account/config/hooks Orca uses. */
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
  /** Why: disabling must persist so startup does not reinstall global agent
   *  hook entries right after the user removes them from Settings or CLI. */
  agentStatusHooksEnabled: boolean
  /** Why: generated tab titles are semantic but subjective, so they stay opt-in
   *  and manual renames remain the stronger user intent. */
  tabAutoGenerateTitle: boolean
  /** Why: pinned tabs can still be closed via the keyboard/native-menu close
   *  path, so this gates that close behind a confirmation prompt to prevent
   *  accidental loss. Defaults on. */
  confirmClosePinnedTab: boolean
  /** When true, Orca requests local awake assertions while hook-reported agents are working. */
  keepComputerAwakeWhileAgentsRun: boolean
  /** Why: macOS terminals must choose between letting Option compose layout
   *  characters (@ on German, € on French) or treating Option as Meta/Esc for
   *  readline shortcuts. Mirrors Ghostty's macos-option-as-alt setting — and
   *  like Ghostty, defaults to 'auto', which fingerprints the active keyboard
   *  layout via navigator.keyboard.getLayoutMap() at runtime and picks
   *  'true' for US / US-International and 'false' for everything else.
   *  'auto'  = layout-aware (default). See docs/terminal-option-key-layout-aware-default.md.
   *  'false' = compose (for non-US keyboards);
   *  'true'  = full Meta on both Option keys;
   *  'left' / 'right' = only that Option key acts as Meta, the other composes. */
  terminalMacOptionAsAlt: 'auto' | 'true' | 'false' | 'left' | 'right'
  /** One-shot migration guard for the 'auto' rollout. Before this field landed,
   *  the field defaulted to 'true' for everyone, meaning a persisted 'true'
   *  could either be an explicit user choice or just the old default. On first
   *  launch after upgrade, if this flag is false and the persisted value is
   *  'true', we reset to 'auto' so non-US users stop getting their keyboard
   *  broken by the stale global default. US users land on 'true' anyway via
   *  detection, so no visible behavior change. Then we flip this flag to true
   *  and never migrate again. */
  terminalMacOptionAsAltMigrated: boolean
  /** Controls whether macOS terminal input translates the physical JIS Yen (¥)
   *  key to a backslash, matching the common terminal expectation for that key. */
  terminalJISYenToBackslash: boolean
  experimentalMobile: boolean
  /** Why: the iOS Simulator feature is default-on for capable macOS hosts, but
   *  users need a durable off switch that hides UI affordances and blocks CLI attach. */
  mobileEmulatorEnabled?: boolean
  /** Preferred iOS Simulator UDID for UI auto-attach and agent CLI attach. */
  mobileEmulatorDefaultDeviceUdid?: string | null
  /** Explicit Android SDK root, used when auto-discovery (ANDROID_HOME / the
   *  default install path) does not find it. `null` (default) auto-discovers. */
  androidSdkPath?: string | null
  /** Auto-restore window for a phone-fit PTY after the last mobile
   *  subscriber leaves. `null` (default) holds the PTY at phone size
   *  indefinitely; the desktop "Restore" banner remains the explicit
   *  return-to-desktop-size action. A finite millisecond value schedules
   *  an automatic restore that long after the last unsubscribe. Clamped
   *  on read into [5_000ms, 60min] to defend against bad config.
   *  See docs/mobile-fit-hold.md. */
  mobileAutoRestoreFitMs: number | null
  /** Experimental: floating animated pet (claude.webp) in the bottom-right
   *  corner. Opt-in because it's a cosmetic joke feature; users who leave it
   *  off never mount the overlay. Toggling takes effect immediately in the
   *  current session (no relaunch) because it is purely renderer-side. */
  experimentalPet: boolean
  /** Legacy persisted key from before the sidekick -> pet rename. Read only
   *  during migration; new writes use experimentalPet. */
  experimentalSidekick?: boolean
  /** Experimental: left-sidebar Agents view with a threaded feed for agent
   *  completions, blocking states, unread state, and worktree creation events. */
  experimentalActivity: boolean
  /** One-shot migration guard for defaulting the Agents view off for all
   *  users. Once set, later explicit opt-ins persist normally. */
  experimentalActivityDefaultedOffForAllUsers?: boolean
  /** Experimental: persistent terminal pane attention ring for terminal bell
   *  and agent-completion events. Opt-in while the signal/noise balance is
   *  being tested. */
  experimentalTerminalAttention: boolean
  /** Experimental: automatically sleep completed, resumable background agent terminals. */
  experimentalAgentHibernation?: boolean
  /** Milliseconds a completed agent must stay idle before hibernation can be considered. */
  agentHibernationIdleMs?: number
  /** Experimental: opt-in preview of the updated worktree-card layout and metadata behavior. */
  experimentalNewWorktreeCardStyle?: boolean
  /** Experimental: per-workspace on-demand environment recipes and setup surface. */
  experimentalEphemeralVms?: boolean
  /** Compact worktree cards by hiding a redundant metadata row when the title
   *  and branch already say the same thing. */
  compactWorktreeCards: boolean
  /** Legacy persisted key from the Experimental rollout. New writes use
   *  compactWorktreeCards. */
  experimentalCompactWorktreeCards?: boolean
  /** Experimental: when creating a worktree, automatically symlink a
   *  user-configured set of files/folders from the primary checkout (e.g.
   *  `.env`, `node_modules`) into the new worktree. Opt-in while the
   *  configuration surface and edge cases (conflicts with existing paths,
   *  cleanup on worktree delete) are still being worked out. */
  experimentalWorktreeSymlinks: boolean

  /** Active non-local runtime environment for client-routed RPC. `null`
   *  preserves the current local desktop behavior. */
  activeRuntimeEnvironmentId?: string | null
  /** GitHub Project mode state — pinned/recent/active project, last selected
   *  view per project. Optional because profiles created before this feature
   *  landed won't have the key; `getDefaultSettings()` hydrates the empty
   *  default via the persistence merge. */
  githubProjects?: GitHubProjectSettings
  /** AI-generated commit messages: agent + model + per-model thinking +
   *  user-customizable prompt suffix. Optional so existing profiles do not
   *  require a migration step before this feature lands. */
  commitMessageAi?: CommitMessageAiSettings
  /** Source-control AI generation settings for commit messages and hosted-review drafts. */
  sourceControlAi?: SourceControlAiSettings
  /** GitLab project preferences — pinned + recent project paths.
   *  Optional for backward compatibility with profiles saved before
   *  GitLab support; the persistence merge fills the empty default. */
  gitlabProjects?: GitLabProjectSettings
  /** Anonymous product-telemetry state. Optional because the one-shot
   *  migration in `Store.load()` is what populates it on first boot of the
   *  telemetry release; before migration runs, the field is absent. After
   *  migration every user has `installId` set and `optedIn` is `true` (new
   *  users) or `null` (existing users awaiting the first-launch banner).
   *
   *  Why this block carries only consent + identity state, not volatile
   *  counters: DAU and crash attribution are both out of v1 scope
   *  (daily_active_user is derived server-side from app_opened; crashes are
   *  handled by a separate crash-reporting lane, not product telemetry). So
   *  there is no lastActiveDate, no lastSessionId, and no heartbeat
   *  timestamp here — adding any of those would amplify the debounced
   *  settings write on a fast cadence and couple user preferences to
   *  volatile telemetry counters. Keep this surface to values that only
   *  change on explicit consent transitions. */
  telemetry?: {
    /** New users: initialized to `true` at install.
     *  Existing users: `null` until they resolve the first-launch banner. */
    optedIn: boolean | null
    /** Anonymous UUID v4. Generated on first run. Stable across launches; not surfaced in the UI. */
    installId: string
    /** Cohort marker set once during migration. True for users with a
     *  pre-existing profile (gates the existing-user opt-in banner);
     *  false for fresh installs (no first-launch surface). */
    existedBeforeTelemetryRelease: boolean
  }
  /** Local voice/dictation configuration (Phase 1 voice feature). Optional
   *  because profiles created before voice landed won't have the key;
   *  `getDefaultSettings()` hydrates `getDefaultVoiceSettings()` via the
   *  `{ ...defaults, ...parsed }` merge in persistence.ts. Treat as
   *  effectively present at runtime — the renderer should still fall back to
   *  defaults when reading optional sub-fields. */
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
  /** Command template used when `agentId === 'custom'`. Tokenized POSIX-style;
   *  `{prompt}` is substituted with the diff prompt (argv delivery). When the
   *  template has no `{prompt}`, the prompt is piped via stdin. */
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

// Subset of the renderer's onboarding-step Ghostty `DiscoveryState['status']`
// values that ever ship a telemetry event. The UI-only states (`'idle'`,
// `'detecting'`) never fire `onboarding_ghostty_discovered`. Lives in
// `shared/` because the schema in `telemetry-events.ts` (node-tsconfig) and
// `ThemeStep.tsx` (web-tsconfig) both need it for the compile-time
// schema-vs-renderer enum sync guard.
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
  /** Present when delivered is false. Tells the caller why delivery was skipped. */
  reason?:
    | 'disabled'
    | 'source-disabled'
    | 'suppressed-focus'
    | 'cooldown'
    | 'not-supported'
    | 'not-displayed'
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
  // Why: UI state flag (panel visibility), not an activation event. The
  // telemetry checklist enum in telemetry-events.ts intentionally omits this.
  dismissed: boolean
}

export type OnboardingState = {
  // Why: numeric step meanings can change when pages are removed; persisted
  // state needs a version marker so migration does not re-run on new progress.
  flowVersion: number
  closedAt: number | null
  outcome: OnboardingOutcome | null
  // Sentinel `-1` = not started; `1..5` = highest wizard step the user
  // finished. Kept as `number` (not a literal union) because callers clamp
  // via `Math.max`/`Math.min` against arbitrary numerics.
  lastCompletedStep: number
  checklist: OnboardingChecklistState
}

export type NotificationPermissionStatusResult = {
  supported: boolean
  platform: NodeJS.Platform
  requested: boolean
}

export type WorktreeCardProperty =
  | 'status'
  | 'unread'
  // Legacy persisted preference. CI status is now represented by linked PR metadata.
  | 'ci'
  // Internal migration-only property for legacy detailed cards that showed
  // branch identity as a visible row.
  | 'branch'
  // Task metadata shown on workspace cards. Kept as provider-specific
  // persisted values so older profiles and provider-specific fetch paths work.
  | 'issue'
  | 'linear-issue'
  | 'pr'
  | 'automation'
  | 'comment'
  | 'ports'
  // Why: inline list of agent activity rendered directly inside each
  // workspace card when the experimental agent-activity feature is on. On by
  // default (see DEFAULT_WORKTREE_CARD_PROPERTIES in shared/constants.ts) —
  // live agent activity is the primary reason users opt into the feature.
  | 'inline-agents'

export type WorktreeCardMode = 'Default' | 'Compact'

export type AgentActivityDisplayMode = 'compact' | 'full'

export type StatusBarItem =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode-go'
  | 'kimi'
  | 'minimax'
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

export type PersistedUIState = {
  lastActiveRepoId: string | null
  lastActiveWorktreeId: string | null
  sidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarTab: RightSidebarTab
  rightSidebarExplorerView: RightSidebarExplorerView
  rightSidebarWidth: number
  markdownTocPanelWidth?: number
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  /** Project header ordering in `groupBy: 'repo'`, independent of workspace
   *  `sortBy`. 'manual' (default) uses the persisted repo order and enables
   *  header drag; 'recent' orders by each project's most recent visible
   *  workspace activity. */
  projectOrderBy: ProjectOrderBy
  /** Deprecated; the Active only filter is retired and ignored on hydration. */
  showActiveOnly: boolean
  /** Hide sleeping/inactive workspaces from workspace navigation. Off by default. */
  hideSleepingWorkspaces?: boolean
  /** Which execution hosts the workspace sidebar shows. `all` keeps the mixed
   *  command-center view; specific host IDs focus the sidebar without tearing
   *  down sessions owned by other hosts. */
  workspaceHostScope?: WorkspaceHostScope
  /** Which execution hosts the workspace sidebar shows. `null` means sticky
   *  all-hosts so newly-added hosts appear automatically. */
  visibleWorkspaceHostIds?: VisibleWorkspaceHostIds
  /** User-defined sidebar order for host sections. Missing/new hosts append in
   *  the discovered host order. */
  workspaceHostOrder?: WorkspaceHostOrder
  /** Deprecated legacy positive-form setting. Ignored on hydration. */
  showSleepingWorkspaces?: boolean
  /** Deprecated legacy name used by a short-lived build. Ignored on hydration. */
  showInactiveWorkspaces?: boolean
  /** Hide the repo's original checked-out branch from workspace navigation
   *  (sidebar and Cmd+J jump palette). Folder-mode repos are unaffected —
   *  the predicate in visible-worktrees.ts excludes worktrees with an empty
   *  branch. */
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
  /** One-shot migration flag for deriving card properties from the two
   *  user-facing worktree card modes. */
  _worktreeCardModeDefaulted?: boolean
  agentActivityDisplayMode?: AgentActivityDisplayMode
  workspaceStatuses?: WorkspaceStatusDefinition[]
  workspaceBoardOpacity?: number
  workspaceBoardColumnWidth?: number
  syncTaskStatusFromWorkspaceBoard?: boolean
  /** One-shot migration flag for a short-lived build that persisted the
   *  default workspace statuses in reverse workflow order. Once stamped,
   *  user-authored status ordering is never inferred from IDs/labels again. */
  _workspaceStatusesDefaultOrderMigrated?: boolean
  /** One-shot repair flag for the exact default payload that a short-lived
   *  build persisted in reverse workflow order. */
  _workspaceStatusesReorderedDefaultRepaired?: boolean
  /** One-shot migration flag for default status workflow labels/visuals.
   *  Exact legacy default payloads migrate; customized statuses are preserved. */
  _workspaceStatusesDefaultWorkflowMigrated?: boolean
  /** One-shot migration flag for the old default blue/violet/emerald status
   *  visuals. Once stamped, valid user-authored colors/icons are preserved. */
  _workspaceStatusesDefaultVisualsMigrated?: boolean
  /** One-shot migration flag for adding the default-on Ports status item. */
  _portsStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on Kimi status item. */
  _kimiStatusBarDefaultAdded?: boolean
  /** One-shot migration flag for adding the default-on MiniMax status item. */
  _minimaxStatusBarDefaultAdded?: boolean
  statusBarItems: StatusBarItem[]
  statusBarVisible: boolean
  dismissedUpdateVersion: string | null
  lastUpdateCheckAt: number | null
  pendingUpdateNudgeId?: string | null
  dismissedUpdateNudgeId?: string | null
  /** Whether Orca has already attempted to trigger the macOS notification
   *  permission dialog via a startup notification. Prevents re-firing on
   *  every launch. */
  notificationPermissionRequested?: boolean
  /** Once the user has seen the "your sessions won't be interrupted"
   *  reassurance card, we never show it again. */
  updateReassuranceSeen?: boolean
  /** Per-paneKey "user has visited this row" timestamps, used by the inline
   *  agents list to mute rows the user has already seen. Persisted because
   *  agent rows themselves now survive restart; without persisting acks too,
   *  rows you'd already clicked come back bold on relaunch. Stale entries
   *  keyed on dead panes are inert: a future paneKey reuse stamps a fresh
   *  stateStartedAt that beats the old ack via the existing comparison in
   *  WorktreeCardAgents. Renderer-owned, written through ui:set. */
  acknowledgedAgentsByPaneKey?: Record<string, number>
  /** User-hidden sidebar entry for the setup guide. The Help menu remains
   *  available so this is a reversible declutter preference, not completion. */
  setupGuideSidebarDismissed?: boolean
  /** One-shot migration marker for the browser setup-guide milestone. Existing
   *  profiles missing this marker are evaluated once in the renderer because
   *  full checklist completion depends on runtime probes. */
  setupGuideBrowserMilestoneMigrated?: boolean
  /** Existing users who completed or dismissed the pre-browser checklist stay
   *  complete after the browser milestone is added. */
  setupGuideBrowserMilestoneLegacyComplete?: boolean
  /** User-dismissed browser import hint in the browser toolbar. Import remains
   *  available from Settings > Browser and the toolbar overflow menu. */
  browserImportHintHidden?: boolean
  /** Why: Windows-only. Set once after the window first hides to the system
   *  tray, so the "Orca is still running" notification shows only on first use. */
  trayMinimizeNoticeShown?: boolean
  /** User dismissed the first-run Mobile Emulator intro (Keep, Hide, or close).
   *  Reversible only by re-enabling the feature in Settings. */
  mobileEmulatorTabIntroDismissed?: boolean
  /** User deferred the in-pane Mobile Emulator CLI + skill setup guide. */
  mobileEmulatorAgentSetupDismissed?: boolean
  /** One-shot rollout notice for manual project ordering becoming the default.
   *  Absent or true means the sidebar callout stays hidden. */
  projectOrderManualDefaultNoticeDismissed?: boolean
  /** User-hidden empty-state usage CTA in the status bar. Permanently hides the
   *  "Connect AI accounts to see usage" prompt even if all providers are later
   *  disconnected — a dismissed teaching nudge stays dismissed. */
  usageEmptyStateDismissed?: boolean
  /** URL to navigate to when a new browser tab is opened. Null means blank tab.
   *  Phase 3 will expand this to a full BrowserSessionProfile per workspace. */
  browserDefaultUrl?: string | null
  browserDefaultSearchEngine?: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  /** Electron browser zoom level applied when a new local browser tab is created. */
  browserDefaultZoomLevel?: number
  /** Optional Kagi private-session link used only when Kagi is the search engine. */
  browserKagiSessionLink?: string | null
  /** Saved window bounds so the app restores to the user's last position/size
   *  instead of maximizing on every launch. */
  windowBounds?: { x: number; y: number; width: number; height: number } | null
  /** Whether the window was maximized when it was last closed. */
  windowMaximized?: boolean
  /** One-shot migration flag: 'recent' used to mean the weighted smart sort
   *  (v1→v2 rename). When this flag is absent and sortBy is 'recent', the
   *  main-process load() migrates it to 'smart' and sets this flag so the
   *  migration never re-fires — allowing users to intentionally select the
   *  new 'recent' (last-activity) sort without it being clobbered on restart. */
  _sortBySmartMigrated?: boolean
  /** LEGACY one-shot flag from the experimental-toggle era of the inline
   *  agents feature. It was stamped unconditionally on every successful
   *  load() in prior builds (regardless of whether the experiment was on),
   *  so it cannot be used to detect "already migrated under the new
   *  default-on rules" — every prior-RC user already has it set to true on
   *  disk. Kept persisted for forward-compat with rollback to a pre-default-on
   *  build that still reads it; the actual migration gate is now
   *  `_inlineAgentsDefaultedForAllUsers` below. */
  _inlineAgentsDefaultedForExperiment?: boolean
  /** One-shot migration flag for the default-on rollout of the inline
   *  agents feature. Set once on first load after upgrade once the
   *  'inline-agents' card property has been ensured in
   *  `worktreeCardProperties`. Distinct from
   *  `_inlineAgentsDefaultedForExperiment` because that legacy flag was
   *  stamped on every prior load and so is permanently dirty for the
   *  prior-RC opt-out cohort the widened migration is meant to reach. */
  _inlineAgentsDefaultedForAllUsers?: boolean
  /** One-shot migration flag for card properties that were split out after
   *  the original metadata toggles shipped. Set once so later deliberate
   *  unchecks of Linear issue and Ports stick across restarts. */
  _expandedWorktreeCardPropertiesDefaulted?: boolean
  /** Snapshot of totalAgentsSpawned captured the first time we see the current
   *  app version. Why: the nag threshold counts agents spawned *since the
   *  user's last update* so a fresh install or new release does not trigger
   *  the notification immediately. Reset whenever starNagAppVersion changes. */
  starNagBaselineAgents?: number | null
  /** The app version that set the current baseline. When the live app version
   *  differs from this value, the baseline is re-captured on next agent
   *  spawn — effectively restarting the nag countdown after each update. */
  starNagAppVersion?: string | null
  /** Next threshold (agents spawned since baseline) at which the star-nag
   *  notification should fire. Starts at 35 and doubles each time the user
   *  dismisses the notification without starring. */
  starNagNextThreshold?: number
  /** Once the user has starred Orca (from any entry point) we permanently
   *  suppress the nag — no further thresholds, no notifications. */
  starNagCompleted?: boolean
  /** Timestamp until which nonterminal dismissals suppress threshold prompts.
   *  Force-show bypasses this for dev/testing. */
  starNagDeferredUntil?: number | null
  /** App version that already consumed the first successful-agent value-moment ask.
   *  Main-owned so remote/web clients cannot spoof the once-per-version cap. */
  starNagAgentValueMomentAppVersion?: string | null
  trustedOrcaHooks?: PersistedTrustedOrcaHooks
  setupScriptPromptDismissedRepoIds?: string[]
  /** Whether the experimental pet overlay is currently visible. Separate
   *  from the experimentalPet settings flag so "Hide pet" from the
   *  status-bar menu is a reversible dismiss (re-show without re-enabling the
   *  feature). Absent = treated as true so existing users see the pet
   *  the first time they enable the experimental flag. */
  petVisible?: boolean
  /** Active pet id: one of the bundled ids or a custom UUID from
   *  customPets. Unknown ids fall back to the default at read time so
   *  removing a custom pet the user had selected doesn't leave the
   *  overlay rendering nothing. */
  petId?: string
  /** User-uploaded pet images. Bytes live under the legacy
   *  userData/sidekicks/custom/ folder; this field is the metadata index so
   *  custom pets ride the existing PersistedUIState save pipeline. */
  customPets?: CustomPet[]
  /** On-screen size of the pet overlay in CSS pixels (square box).
   *  Clamped to [PET_SIZE_MIN, PET_SIZE_MAX] when read. */
  petSize?: number
  /** Legacy persisted keys from before the sidekick -> pet rename. Read only
   *  during migration; new writes use the pet* names above. */
  sidekickVisible?: boolean
  sidekickId?: string
  customSidekicks?: CustomPet[]
  sidekickSize?: number
  /** Page-position state for Tasks. Source/repo/team/project selections keep
   *  using their existing settings paths; this only restores transient tabs
   *  and applied searches. */
  taskResumeState?: TaskResumeState
  workspaceCleanup?: WorkspaceCleanupUIState
  /** Feature tips already surfaced to the user. Startup only opens the tips
   *  modal when this list is missing one of the current tip ids. */
  featureTipsSeenIds?: FeatureTipId[]
  /** Local product-state facts: feature ids the user has actually used.
   *  Used by education surfaces to avoid teaching already-discovered features. */
  featureInteractions?: FeatureInteractionState
  /** Contextual tours already surfaced to the user. Unknown ids are ignored
   *  during hydration so downgrade/upgrade cycles remain forward-compatible. */
  contextualToursSeenIds?: ContextualTourId[]
  /** Whether this profile may receive automatic contextual tours from this
   *  rollout. Missing means the renderer has not classified the profile yet. */
  contextualToursAutoEligible?: boolean
}

export const PET_SIZE_MIN = 60
export const PET_SIZE_MAX = 360
export const PET_SIZE_DEFAULT = 180

/** Metadata for a user-uploaded pet image. `id` is the stable identifier;
 *  the on-disk filename (preserving the original extension) lives in `fileName`.
 *  The renderer never learns the absolute path — it asks main for the bytes
 *  via pet:read using (id, fileName). */
export type CustomPet = {
  id: string
  label: string
  fileName: string
  /** MIME type needed so the renderer builds a Blob with the correct
   *  Content-Type — especially image/svg+xml, which browsers won't render
   *  from a misdeclared blob URL. */
  mimeType: string
  /** Storage layout. `image` = legacy flat file at `custom/<id>.<ext>`.
   *  `bundle` = `.codex-pet` import expanded into `custom/<id>/`. Absent =
   *  legacy `image` for backwards compatibility with persisted state. */
  kind?: 'image' | 'bundle'
  /** Sprite-sheet metadata captured at import time. Present iff this entry
   *  came from a `.codex-pet` bundle and the manifest declared frame layout.
   *  `columns`/`rows`/`sheetWidth`/`sheetHeight` are derived in main from
   *  the decoded sheet so the renderer doesn't need to probe the image. */
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
  /** Manifest-declared fps captured even when the manifest omits `frame` and
   *  the renderer falls back to auto-detected frames. Lets DetectedSpriteFrame
   *  honor the bundle's intended playback speed instead of a hardcoded 8 fps. */
  spriteFps?: number
}

/** One animation strip within a sprite sheet: `row` is the y-index (0-based)
 *  and `frames` is the number of consecutive cells played left-to-right. */
export type SpriteAnimation = {
  row: number
  frames: number
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
  legacyPaneKey: string
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
  /** Sparse-checkout presets keyed by repoId. Empty record on first launch;
   *  presets are managed from the new-workspace composer and repo settings. */
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
  /** Legacy single-blob session. Retained as the canonical 'local' execution
   *  host partition so an app downgrade still reads its workspace. Non-local
   *  hosts live in workspaceSessionsByHostId, keyed by ExecutionHostId. */
  workspaceSession: WorkspaceSessionState
  /** Per-execution-host session partitions for non-'local' hosts (ssh:/runtime:).
   *  Mixed-host writes stay isolated here; 'local' stays in workspaceSession so
   *  pre-partition builds keep working. Optional/absent on legacy files. */
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
  sshTargets: SshTarget[]
  /** SSH config aliases the user explicitly deleted. Suppresses re-import of the
   *  matching ~/.ssh/config host on the next sync so a deleted host does not
   *  reappear. Cleared for an alias when the user re-adds it or re-adopts config. */
  deletedSshConfigAliases: string[]
  sshRemotePtyLeases: SshRemotePtyLease[]
  /** Daemon session ids of live local Claude launches. Seeds the Claude
   *  live-PTY gate on startup so an early OAuth refresh cannot rotate the
   *  single-use refresh token out from under a still-running daemon CLI. */
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
// Re-exported from git-status-types.ts so mobile can share the runtime git
// wire contract without importing this desktop-oriented aggregate type module.

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
  // For display formatting — sourced from aggregates, not the event log,
  // so it survives event trimming.
  firstEventAt: number | null // timestamp of first-ever event, for "tracking since..."
}

// ─── Memory dashboard ──────────────────────────────────────────────
// Resource-metrics snapshot shared across main, preload, and renderer so
// the IPC payload is the same shape everywhere. Memory is in bytes; CPU
// is a percentage (can exceed 100 on multi-core).

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
  /** Oldest-first memory samples (bytes) for the whole Orca app, one per
   *  successful collection. Used to render the sparkline in the dashboard.
   *  Empty before the first snapshot is recorded. */
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
  /** Oldest-first memory samples (bytes) for this worktree's tracked
   *  subtrees, one per successful collection. */
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
