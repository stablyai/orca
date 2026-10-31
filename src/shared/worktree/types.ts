import type { ExecutionHostId } from '../execution-host'
import type { WorktreeCatalogVersion } from './catalog-version'
import type { AutomationExecutionTargetType } from '../automations-types'
import type { TaskSourceContext } from '../task-source-context'
import type { TuiAgent } from '../tui-agent'
import type { DiffComment, MobileDiffReviewState } from '../diff-comment-types'
import type { EphemeralVmCheckoutMode } from '../orca-yaml-hook-types'
import type { BuiltInWorktreeVisibilitySourceId } from '../repo-types'
import type { WorktreeIdentity } from './identity'
import type { WorktreeScanFailureKind } from '../worktree-scan-failure'
import type { SmartTier } from '../sidebar-list/sort-stamps'

export type WorkspaceAttachmentOrigin = {
  kind: 'observed'
  tabId: string
  paneKey?: string
  hostId?: ExecutionHostId
  label?: string
  agent?: string
  sessionId?: string
}

export type WorkspaceAttachment = {
  provider: 'github' | 'gitlab' | 'linear' | 'jira' | 'bitbucket' | 'azure-devops' | 'gitea'
  type: 'issue' | 'pr' | 'mr'
  number: number
  identifier?: string
  title?: string
  url?: string
  repoId?: string
  linearIdentifier?: string
  jiraIdentifier?: string
  linearWorkspaceId?: string
  linearOrganizationUrlKey?: string
  taskSourceContext?: TaskSourceContext
  origins?: WorkspaceAttachmentOrigin[]
}

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

export type GitWorktreeInfo = {
  path: string
  head: string
  branch: string
  isBare: boolean
  isSparse?: boolean
  locked?: boolean
  lockReason?: string
  /** Git 2.36+ reports prunable registration; older Git needs a directory-existence probe. */
  prunable?: boolean
  prunableReason?: string
  /** Git lists the main checkout first; linked worktrees set false. */
  isMainWorktree: boolean
  /** Local delete failed after Git deregistration; list the leftover so Delete can retry. */
  removalError?: string
}

/** Read HEAD/branch without spawning Git to refresh background head moves without structural worktrees:changed fanout. */
export type WorktreeHeadIdentity = {
  worktreePath: string
  head: string
  /** Full ref (e.g. `refs/heads/main`), or null for a detached HEAD. */
  branch: string | null
}

/** `worktreePaths` names the only checkouts whose status the burst can have
 *  changed; absent means unattributed, so every listener must refresh. */
export type GitStatusMetadataChangedEvent = {
  repoId: string
  worktreePaths?: string[]
}

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
  /** Projection of persisted display-name provenance. */
  displayNameMode?: 'fixed' | 'automatic'
  comment: string
  linkedIssue: number | null
  linkedPR: number | null
  /** GitHub PR hidden from branch discovery after an explicit unlink. */
  suppressedGitHubPR?: number | null
  linkedLinearIssue: string | null
  linkedLinearIssueWorkspaceId?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  // Separate provider slots preserve simultaneous multi-provider links and existing GitHub readers. Optional fields keep legacy records/fixtures compatible.
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  linkedWorkItem?: WorkspaceLinkedItem | null
  /** All attachments; singular fields select the active review/task for older readers. */
  linkedItems?: WorkspaceAttachment[]
  linkedTaskSourceContext?: TaskSourceContext | null
  isArchived: boolean
  isUnread: boolean
  isPinned: boolean
  sortOrder: number
  /** User-authored sidebar ordering. Higher values render earlier in Manual sort. */
  manualOrder?: number
  /** Recent's key, stamped by the owning host on events (and still by the window). */
  lastActivityAt: number
  /** Smart's tier, stamped by the owning host on agent transitions; absent is Rest. */
  smartTier?: SmartTier
  /** When the workspace entered its tier. */
  smartAt?: number
  /** Owning host throttles terminal-input/phone-attach timestamps for cleanup and other last-active readers; never use as a sort key. */
  lastTerminalUseAt?: number
  /** Orca-created worktrees get a short Recent grace period against ambient PTY bumps. Discovered/legacy rows omit this timestamp. */
  createdAt?: number
  /** Seed a replacement terminal with the original agent after every visible surface has closed. */
  createdWithAgent?: TuiAgent
  /** Awaiting a first-agent-message branch/title rename. */
  pendingFirstAgentMessageRename?: boolean
  /** Last auto-rename generation failure for the badge; null/undefined covers unattempted, successful and benign skips. */
  firstAgentMessageRenameError?: string | null
  sparseDirectories?: string[]
  sparseBaseRef?: string
  /** Saved preset identity; clear when refresh reports the worktree is no longer sparse. */
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
  /** The host is deleting this checkout in the background; Git lists it until that finishes.
   *  Sent only to clients that advertise `worktree.background-removal.v1`. */
  removing?: true
} & GitWorktreeInfo

/** Only CLI-created workspaces carry this; missing means not CLI-created, including older rows. */
export type CliWorkspaceProvenance = {
  kind: 'created-by-cli'
  createdAt: number
  /** Calling Orca terminal, if any, distinguishes agent-issued creates from external-shell creates. */
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
  /** Recorded by a host for another owner's run; the host's own run bookkeeping ignores it. */
  origin?: 'client'
}

/** What another owner sends a host; the host stamps `createdAt` and `origin` itself. */
export type ClientAutomationWorkspaceProvenance = Omit<
  AutomationWorkspaceProvenance,
  'kind' | 'createdAt' | 'origin'
>

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
  /** Why a non-authoritative listing could not be scanned; additive, older hosts omit it. */
  unavailableReason?: string
  /** Structured cause captured by the execution host when a scan fails. */
  failureKind?: WorktreeScanFailureKind
  /** Which catalog this listing describes; additive, older hosts omit it. */
  catalogVersion?: WorktreeCatalogVersion
  /** The repo's WSL distro is stopped or unverifiable, so rows are stored ones; additive, older hosts omit it. */
  wslDistroStopped?: { distro: string; state: 'stopped' | 'unverifiable' }
}
