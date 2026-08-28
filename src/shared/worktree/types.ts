import type { ExecutionHostId } from '../execution-host'
import type { AutomationExecutionTargetType } from '../automations-types'
import type { TaskSourceContext } from '../task-source-context'
import type { TuiAgent } from '../tui-agent'
import type { DiffComment, MobileDiffReviewState } from '../diff-comment-types'
import type { EphemeralVmCheckoutMode } from '../orca-yaml-hook-types'
import type { BuiltInWorktreeVisibilitySourceId } from '../repo-types'
import type { WorktreeIdentity } from './identity'

export type WorkspaceLinkedItem = {
  provider: 'github' | 'gitlab' | 'linear' | 'jira'
  type: 'issue' | 'pr' | 'mr'
  number: number
  title: string
  url: string
  linearIdentifier?: string
  jiraIdentifier?: string
  repoId?: string
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
  /** Immutable host/instance identity. Optional while legacy rows migrate. */
  identity?: WorktreeIdentity
  repoId: string
  /** Durable project identity. Optional while legacy repo-only workspaces migrate. */
  projectId?: string
  /** Execution host that owns the workspace. Optional for pre-project-host metadata. */
  hostId?: ExecutionHostId
  /** Renderer projection of the paired runtime that transports operations to `hostId`. */
  runtimeOwnerEnvironmentId?: string
  /** Authenticated client that created this workspace. Missing means unknown legacy origin. */
  creatorProvenance?: WorkspaceCreatorProvenance
  /** Host-specific setup used to create/run this workspace. */
  projectHostSetupId?: string
  /** Checkout ownership for a recipe-provisioned main workspace. */
  ephemeralVmCheckoutMode?: EphemeralVmCheckoutMode
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
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
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
  cliProvenance?: CliWorkspaceProvenance
} & GitWorktreeInfo

/** Provenance for workspaces created through `orca worktree create`. Absent on
 *  workspaces created before this field existed and on every non-CLI create, so
 *  consumers must read "missing" as "not CLI-created". */
export type CliWorkspaceProvenance = {
  kind: 'created-by-cli'
  createdAt: number
  /** Orca terminal the CLI ran inside, when the caller had one — distinguishes
   *  an agent-issued create from one hand-typed in an external shell. */
  callerTerminalHandle?: string
  /** Agent requested via `--agent`, when one was passed. */
  startupAgent?: TuiAgent
}

export type WorkspaceCreatorProvenance =
  | { kind: 'host' }
  | { kind: 'paired-device'; deviceId: string }

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

export type WorktreeOwnership = 'orca-managed' | 'external' | 'unknown-legacy' | 'agent-scratch'

export type DetectedWorktreeListSource = 'git' | 'metadata-fallback' | 'session-fallback'

export type DetectedWorktree = Worktree & {
  ownership: WorktreeOwnership
  selectedCheckout: boolean
  visible: boolean
  /** Optional additive source identity; older hosts omit it. */
  visibilitySource?:
    | { kind: 'built-in'; id: BuiltInWorktreeVisibilitySourceId }
    | { kind: 'custom'; id: string }
}

export type DetectedWorktreeListResult = {
  repoId: string
  authoritative: boolean
  source: DetectedWorktreeListSource
  worktrees: DetectedWorktree[]
}
