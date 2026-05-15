/* GitLab-specific shared types. Split out of `src/shared/types.ts` so
   adding or changing a GitLab type doesn't surface as a merge conflict
   on every upstream sync of the much larger central types file.
   Imports the small base types (CheckStatus, ClassifiedError,
   PRConflictSummary) it depends on; re-exported from `./types` for
   import-stability — existing call sites (`from '../shared/types'`)
   continue to work without changes. */
import type { CheckStatus, ClassifiedError, PRConflictSummary } from './types'

// Why: GitLab's analogue of `GitHubOwnerRepo`. Two structural differences
// from GitHub make the flat owner/repo shape inadequate: (a) projects can
// live under arbitrarily nested groups (`group/subgroup/project`), and
// (b) self-hosted instances live on hostnames other than gitlab.com so the
// host has to travel with the path for URL construction and glab host
// targeting. Aliased as `ProjectRef` in `src/main/gitlab/gl-utils.ts`.
export type GitLabProjectRef = { host: string; path: string }

// ── GitLab MR / issue / work-item shapes ────────────────────────────
// Why: parallel to the GitHub PR/Issue/WorkItem types above. Native
// GitLab state strings are preserved (`opened` vs gh `open`) so we don't
// have to remember whether a value has been mapped — every GitLab-side
// type uses the API's own vocabulary.

export type MRState = 'opened' | 'closed' | 'merged' | 'locked' | 'draft'
export type GitLabIssueState = 'opened' | 'closed'
// Why: glab does not surface a structured "mergeable" field equivalent to
// GitHub's GraphQL `mergeable`; we project the available signals
// (`detailed_merge_status`, `has_conflicts`) onto the same three-value
// shape used by GitHub's PRMergeableState so the UI can stay simple.
export type MRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

// Why: GitLab pipeline jobs and GitHub check-runs map onto the same
// three-state lifecycle. Keep the field names identical to PRCheckDetail
// so the rendering layer can share a row component.
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
  /** Full markdown description as authored on the MR. Optional because
   *  list endpoints omit it; populated on single-MR fetch (`getMR`). */
  description?: string
  /** Author username (GitLab `username`). Optional for the same reason. */
  author?: string | null
  authorAvatarUrl?: string | null
  /** GitLab MR head SHA — pipeline status is keyed off the head commit. */
  headSha?: string
  conflictSummary?: PRConflictSummary
}

// Why: GitLab "emoji awards" are a richer set than GitHub's eight
// reactions; rather than enumerate all of them, carry the raw award name
// and let the renderer decide what to surface.
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
  /** GitLab discussion ID — present only for inline review comments. Used to
   *  resolve/unresolve the discussion via `glab api`. */
  threadId?: string
  /** Whether the discussion has been resolved. Only meaningful when threadId is set. */
  isResolved?: boolean
  line?: number
  startLine?: number
  /** True when GitLab identifies the author as a bot (user `state === 'bot'`
   *  or matching system user heuristics). Mirrors GitHub PRComment.isBot. */
  isBot?: boolean
}

export type GitLabCommentResult = { ok: true; comment: MRComment } | { ok: false; error: string }

export type GitLabIssueInfo = {
  number: number
  title: string
  state: GitLabIssueState
  url: string
  labels: string[]
  /** Full markdown description as authored on the issue. Optional because
   *  list endpoints omit it; populated on single-issue fetch (`getIssue`). */
  description?: string
  /** Author username — populated on single-issue fetch. */
  author?: string | null
  authorAvatarUrl?: string | null
}

export type GitLabViewer = {
  username: string
  email: string | null
}

export type GitLabAssignableUser = {
  username: string
  name: string | null
  avatarUrl: string
}

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
  /** True when an MR's source branch lives in a fork project. The
   *  Start-from picker mirrors GitHub's behavior and disables fork MRs in
   *  v1 because resolving a fork head from the source branch alone is not
   *  safe. */
  isCrossRepository?: boolean
  /** Stamped by the renderer fetcher / optimistic stubs so cross-project
   *  views can attribute rows. Mirrors GitHubWorkItem.repoId. */
  repoId: string
}

export type GitLabMRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** GitLab marks files above its diff size limit as binary; we skip content fetches for these. */
  isBinary: boolean
}

// Why: parallel of GitHubProjectSettings, scoped to plain GitLab
// projects since v1 doesn't ship Projects-v2-style boards. Recent is
// auto-tracked from the picker's paste-URL flow so users coming back to
// projects they've recently visited don't have to re-paste the URL.
// Pinned is reserved for a future UI affordance — defining the field
// now keeps settings migrations simple later.
export type GitLabProjectSettings = {
  pinned: { host: string; path: string }[]
  recent: { host: string; path: string; lastOpenedAt: string }[]
}

// Why: GitLab Todos (gitlab.com/dashboard/todos) are cross-project
// notifications — assigned items, mentions, build failures, review
// requests, etc. The action_name field is open-ended in the API; we
// keep it as a string so new GitLab versions don't break the type.
// target_type narrows to the four shapes Orca renders meaningfully —
// other values (DesignManagement::Design, AlertManagement::Alert)
// fall back to a generic "open URL" treatment in the UI.
export type GitLabTodoTargetType = 'MergeRequest' | 'Issue' | 'Commit' | 'Note'

export type GitLabTodo = {
  id: number
  /** Free-form GitLab action name: 'assigned', 'mentioned', 'build_failed',
   *  'marked', 'approval_required', 'review_requested', 'unmergeable', etc. */
  actionName: string
  targetType: GitLabTodoTargetType | string
  /** iid when target is an MR or Issue; '' for Commit/Note targets where the
   *  identifier is a SHA or note ID instead. */
  targetIid: number | null
  targetTitle: string
  targetUrl: string
  /** Project path (`group/subgroup/project`) for the target. Empty for
   *  rare targets that aren't project-scoped. */
  projectPath: string
  /** Author of the action that produced the todo. Empty when the todo was
   *  generated by the system (e.g. build_failed). */
  authorUsername: string
  authorAvatarUrl: string
  /** ISO timestamp from GitLab. */
  updatedAt: string
  /** GitLab supports todos in 'pending' or 'done' state. v1 only fetches
   *  pending; the field is on the type for future filter support. */
  state: 'pending' | 'done'
}

// Why: per-job pipeline status — surfaces in the GitLab dialog Pipeline
// tab so users can see which job failed and where without leaving Orca.
// Mirrors PRCheckDetail's "single row per check" shape so the rendering
// component is reusable.
export type GitLabPipelineJob = {
  id: number
  name: string
  /** GitLab stage name, e.g. 'build' / 'test' / 'deploy'. */
  stage: string
  /** Raw GitLab job status — 'success' / 'failed' / 'running' / 'pending'
   *  / 'canceled' / 'skipped' / 'manual' / 'created' / 'preparing'. The
   *  renderer maps to a colored pill via the existing status helpers. */
  status: string
  webUrl: string
  /** Duration in seconds. null when the job hasn't finished. */
  duration: number | null
}

// Why: aggregated detail payload for GitLabItemDialog. Parallel to
// GitHubWorkItemDetails. Flattens discussion notes into a single comments
// list — inline review-comment positioning is v1.5 work; this surface is
// "read description + conversation + pipeline + act on it".
export type GitLabWorkItemDetails = {
  /** repoId is stamped by the renderer from the dialog's caller (TaskPage,
   *  picker) — main-process doesn't know Orca's Repo.id. */
  item: Omit<GitLabWorkItem, 'repoId'>
  body: string
  comments: MRComment[]
  /** MR head/base SHAs — populated for MRs only. Reserved for a future
   *  Files tab; the dialog reads `body` for now. */
  headSha?: string
  baseSha?: string
  /** MR-only — populated when the MR's head_pipeline exists. */
  pipelineJobs?: GitLabPipelineJob[]
  participants?: GitLabAssignableUser[]
  /** Issue-only — usernames of current assignees. */
  assignees?: string[]
}

export type GitLabIssueUpdate = {
  state?: 'opened' | 'closed'
  title?: string
  /** Mirrors GitHubIssueUpdate.body — kept ignored on the repoPath-based
   *  flow for the same backward-compat reason. Slug-addressed write paths
   *  cover the body-edit case end-to-end. */
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

// Why: GitLab-native MR list filter — Open / Merged / Closed / All —
// replaces GitHub's search-DSL on the GitLab tab per the agreed scope.
// 'all' maps to no state filter (any state).
export type MRListState = 'opened' | 'merged' | 'closed' | 'all'

// Why: paginated list result for both MRs and combined work-items.
// totalCount / totalPages come from X-Total / X-Total-Pages response
// headers via `glab api -i`, so the renderer can show "Page X of Y".
export type GitLabPagedResult<T> = {
  items: T[]
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  error?: ClassifiedError
}

export type ListMergeRequestsResult = GitLabPagedResult<GitLabWorkItem>
