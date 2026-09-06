import type { ExecutionHostId } from '../execution-host'
import type { TaskSourceContext } from '../task-source-context'
import type { EphemeralVmCheckoutMode } from '../orca-yaml-hook-types'
import type {
  AutomationWorkspaceProvenance,
  CliWorkspaceProvenance,
  GitPushTarget,
  WorkspaceCreatorProvenance,
  WorkspaceLinkedItem,
  WorkspaceStatus
} from './types'
import type { TuiAgent } from '../tui-agent'
import type { OrcaWorkspaceLayout } from '../global-settings-types'
import type { DiffComment, MobileDiffReviewState } from '../diff-comment-types'

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
  /** See Worktree.ephemeralVmCheckoutMode. */
  ephemeralVmCheckoutMode?: EphemeralVmCheckoutMode
  /** See Worktree.creatorProvenance. */
  creatorProvenance?: WorkspaceCreatorProvenance
  displayName: string
  /** True when a user-authored label must survive branch changes. */
  displayNameIsPinned?: boolean
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  /** GitHub PR hidden from branch discovery after an explicit unlink. */
  suppressedGitHubPR?: number | null
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
  linkedWorkItem?: WorkspaceLinkedItem | null
  linkedTaskSourceContext?: TaskSourceContext | null
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
  /** System-owned provenance for workspaces created via `orca worktree create`. */
  cliProvenance?: CliWorkspaceProvenance
}
