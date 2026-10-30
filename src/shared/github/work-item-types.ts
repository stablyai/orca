import type { ClassifiedError } from '../classified-error'
import type { ExecutionHostId } from '../execution-host'
import type { PRCheckDetail } from './check-types'
import type { GitHubIssueTimelineItem, PRComment } from './comment-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRMergeMethodSettings,
  GitHubPRReviewSummary,
  GitHubRepositoryIdentity,
  PRMergeableState,
  PRReviewDecision,
  ProviderCheckSummary
} from './pull-request-types'

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
  // Use API avatars for GHE logins absent on github.com (#8784). gh-pr-view omits them; UI falls back through login URL to initials.
  authorAvatarUrl?: string
  branchName?: string
  baseRefName?: string
  // Head SHA enables cached check-run requests instead of per-row gh pr checks.
  headSha?: string
  prRepo?: GitHubRepositoryIdentity
  additions?: number
  deletions?: number
  changedFiles?: number
  /** Issue-only; older hosts omit it. */
  commentCount?: number
  reviewDecision?: PRReviewDecision | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  assignees?: GitHubAssignableUser[]
  checksSummary?: ProviderCheckSummary
  mergeable?: PRMergeableState
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  maintainerCanModify?: boolean
  // Fork heads use refs/pull/<N>/head for creation and a separate push target in resolvePrBase.
  isCrossRepository?: boolean
  /** Renderer fetches/optimistic stubs stamp origin repo for cross-repo pills and open-in-browser routing. */
  repoId: string
  /** Repo ids can repeat across hosts; stamp the producing host so actions cannot target a same-id twin. */
  repoHostId?: ExecutionHostId
}

export type GitHubWorkItemDetails = {
  // Main lacks Orca Repo.id; renderer stamps it when storing details.
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

/** Piggyback issue/PR sources on Tasks refresh to avoid another IPC round trip. Per-source failures preserve successful items;
 * render items alongside error banners (e.g. private upstream 403), never discard the other side’s success. */
export type ListWorkItemsResult<T> = {
  items: T[]
  sources: {
    issues: GitHubOwnerRepo | null
    prs: GitHubOwnerRepo | null
    /** Raw origin independent of preferences; compare candidates without inferring from effective PR source. */
    originCandidate: GitHubOwnerRepo | null
    /** Raw upstream independent of preferences; selector visibility/tooltips need it even when effective issues source is origin. */
    upstreamCandidate: GitHubOwnerRepo | null
  }
  errors?: {
    issues?: ClassifiedError
    prs?: ClassifiedError
  }
  /** Present only when requested upstream was missing and origin was used; renderer shows a once-per-session toast.
   * Optional literal true preserves legacy consumers and forbids erroneous explicit false writes. */
  issueSourceFellBack?: true
}
