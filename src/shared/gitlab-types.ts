/* GitLab-specific shared types, split from `./types` to avoid merge conflicts on upstream syncs; re-exported from `./types` for import stability. */
import type { CheckStatus, ClassifiedError, PRConflictSummary } from './types'

// Why: flat owner/repo is inadequate — projects nest (`group/subgroup/project`) and self-hosted hosts must travel with the path for URL/glab targeting.
export type GitLabProjectRef = { host: string; path: string }

// ── GitLab MR / issue / work-item shapes ────────────────────────────
// Why: preserve native GitLab state strings (`opened`, not gh `open`) so values are never ambiguously mapped.

export type MRState = 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
export type GitLabIssueState = 'opened' | 'closed'
// Why: glab has no structured `mergeable`; we project `detailed_merge_status`/`has_conflicts` onto GitHub's three-value shape.
export type MRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

// Why: field names mirror PRCheckDetail so the rendering layer can share a row component.
export type MRCheckDetail = {
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
    | null
  url: string | null
}

export type MRInfo = {
  number: number
  title: string
  state: MRState
  url: string
  pipelineStatus: CheckStatus
  updatedAt: string
  mergeable: MRMergeableState
  /** Full markdown description. Optional — list endpoints omit it; populated on single-MR fetch (`getMR`). */
  description?: string
  /** Author username (GitLab `username`). Optional for the same reason. */
  author?: string | null
  authorAvatarUrl?: string | null
  /** GitLab MR head SHA — pipeline status is keyed off the head commit. */
  headSha?: string
  /** Target branch name for review-created worktree compare-base repair. */
  baseRefName?: string
  conflictSummary?: PRConflictSummary
}

// Why: GitLab emoji awards are open-ended, so we carry the raw award name and let the renderer decide.
export type GitLabReaction = {
  name: string
  count: number
}

export type MRComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  reactions?: GitLabReaction[]
  /** File path for inline review comments (absent for top-level discussion notes). */
  path?: string
  /** GitLab discussion ID (inline review comments only). Used to resolve/unresolve via `glab api`. */
  threadId?: string
  /** Whether the discussion has been resolved. Only meaningful when threadId is set. */
  isResolved?: boolean
  line?: number
  startLine?: number
  /** True when GitLab marks the author as a bot. Mirrors GitHub PRComment.isBot. */
  isBot?: boolean
}

export type GitLabCommentResult = { ok: true; comment: MRComment } | { ok: false; error: string }
export type GitLabDiscussionResolveResult = { ok: true } | { ok: false; error: string }

export type GitLabJobTraceResult = { ok: true; trace: string } | { ok: false; error: string }

export type GitLabRetryJobResult =
  | { ok: true; job?: GitLabPipelineJob }
  | { ok: false; error: string }

export type GitLabIssueInfo = {
  number: number
  title: string
  state: GitLabIssueState
  url: string
  labels: string[]
  /** ISO 8601 timestamp. Optional — single-issue fetches may omit it. */
  updatedAt?: string
  /** Full markdown description. Optional — list endpoints omit it; populated on single-issue fetch (`getIssue`). */
  description?: string
  /** Author username — populated on single-issue fetch. */
  author?: string | null
  authorAvatarUrl?: string | null
}

export type GitLabViewer = {
  username: string
  email: string | null
}

export type GitLabAuthDiagnostic = {
  glabAvailable: boolean
  authenticated: boolean
  hosts: string[]
  activeHost: string | null
  envTokenInProcess: 'GITLAB_TOKEN' | 'GLAB_TOKEN' | null
  error: string | null
}

export type GitLabRateLimitBucket = {
  limit: number
  remaining: number
  resetAt: number | null
}

export type GitLabRateLimitSnapshot = {
  rest: GitLabRateLimitBucket | null
  host: string | null
  fetchedAt: number
}

export type GetGitLabRateLimitResult =
  | { ok: true; snapshot: GitLabRateLimitSnapshot }
  | { ok: false; error: string }

export type GitLabAssignableUser = {
  id?: number
  username: string
  name: string | null
  avatarUrl: string
  state?: string | null
}

export type GitLabMRApprovalRule = {
  id: number
  name: string
  approvalsRequired: number
  approved: boolean
}

export type GitLabMRApprovalState = {
  approvalsRequired: number | null
  approvalsLeft: number | null
  approvedBy: GitLabAssignableUser[]
  rules: GitLabMRApprovalRule[]
}

export type GitLabMRReviewersUpdateResult =
  | { ok: true; reviewers: GitLabAssignableUser[] }
  | { ok: false; error: string }

export type GitLabWorkItem = {
  id: string
  type: 'issue' | 'mr'
  number: number
  title: string
  state: 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  /** True when an MR's source branch lives in a fork. Fork MRs are disabled in v1 — resolving a fork head from the source branch alone isn't safe. */
  isCrossRepository?: boolean
  /** Stamped by the renderer so cross-project views can attribute rows. Mirrors GitHubWorkItem.repoId. */
  repoId: string
  /** Exact GitLab project that produced this row — mutations/details use it instead of re-resolving the repo preference. */
  projectRef?: GitLabProjectRef
}

export type GitLabMRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** GitLab marks files above its diff size limit as binary; we skip content fetches for these. */
  isBinary: boolean
  diff?: string
}

export type GitLabMRInlineCommentInput = {
  body: string
  path: string
  oldPath?: string
  line: number
  baseSha: string
  startSha: string
  headSha: string
}

// Why: mirrors GitHubProjectSettings. `pinned` is reserved for a future UI affordance — defined now to keep settings migrations simple.
export type GitLabProjectSettings = {
  pinned: { host: string; path: string }[]
  recent: { host: string; path: string; lastOpenedAt: string }[]
}

// Why: only the four Todo target types Orca renders meaningfully; others (e.g. DesignManagement::Design) fall back to a generic "open URL".
export type GitLabTodoTargetType = 'MergeRequest' | 'Issue' | 'Commit' | 'Note'

export type GitLabTodo = {
  id: number
  /** Free-form GitLab action name, e.g. 'assigned', 'mentioned', 'build_failed', 'review_requested'. */
  actionName: string
  targetType: GitLabTodoTargetType | string
  /** iid for MR/Issue targets; absent for Commit/Note targets where the identifier is a SHA or note ID. */
  targetIid: number | null
  targetTitle: string
  targetUrl: string
  /** Project path (`group/subgroup/project`). Empty for targets that aren't project-scoped. */
  projectPath: string
  /** Empty when the todo was system-generated (e.g. build_failed). */
  authorUsername: string
  authorAvatarUrl: string
  /** ISO timestamp from GitLab. */
  updatedAt: string
  /** v1 only fetches 'pending'; 'done' is on the type for future filter support. */
  state: 'pending' | 'done'
}

// Why: per-job pipeline status for the dialog's Pipeline tab. Mirrors PRCheckDetail so the rendering component is reusable.
export type GitLabPipelineJob = {
  id: number
  pipelineId?: number
  name: string
  /** GitLab stage name, e.g. 'build' / 'test' / 'deploy'. */
  stage: string
  /** Raw GitLab job status — 'success' / 'failed' / 'running' / 'pending' / 'canceled' / 'skipped' / 'manual' / 'created' / 'preparing'. */
  status: string
  webUrl: string
  /** Duration in seconds. null when the job hasn't finished. */
  duration: number | null
}

// Why: aggregated detail for GitLabItemDialog; flattens discussions into one comments list (inline positioning is v1.5 work).
export type GitLabWorkItemDetails = {
  /** repoId is stamped by the renderer's caller — the main process doesn't know Orca's Repo.id. */
  item: Omit<GitLabWorkItem, 'repoId'>
  body: string
  comments: MRComment[]
  /** MR head/base SHAs — MRs only. Reserved for a future Files tab. */
  headSha?: string
  baseSha?: string
  startSha?: string
  files?: GitLabMRFile[]
  /** MR-only — populated when the MR's head_pipeline exists. */
  pipelineJobs?: GitLabPipelineJob[]
  /** MR-only reviewers and approval status. */
  reviewers?: GitLabAssignableUser[]
  approvalState?: GitLabMRApprovalState
  participants?: GitLabAssignableUser[]
  /** Issue-only — usernames of current assignees. */
  assignees?: string[]
}

export type GitLabIssueUpdate = {
  state?: 'opened' | 'closed'
  title?: string
  /** Body edits use the REST issue endpoint (not `glab issue update`) so mobile can save the markdown description. */
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type GitLabMRUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
}

// Why: GitLab-native MR list filter replacing GitHub's search-DSL; 'all' maps to no state filter.
export type MRListState = 'opened' | 'merged' | 'closed' | 'all'

// Why: totalCount / totalPages come from X-Total / X-Total-Pages headers via `glab api -i`.
export type GitLabPagedResult<T> = {
  items: T[]
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  error?: ClassifiedError
}

export type ListMergeRequestsResult = GitLabPagedResult<GitLabWorkItem>
