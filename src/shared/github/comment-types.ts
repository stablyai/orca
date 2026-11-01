import type { GitHubRepositoryIdentity } from './pull-request-types'

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
  viewerHasReacted?: boolean
}

export type PRComment = {
  id: number
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  reactions?: GitHubReaction[]
  /** GraphQL node ID for GitHub comments that support reaction mutations. */
  reactionSubjectId?: string
  /** File path for inline review comments (absent for top-level conversation comments). */
  path?: string
  /** Inline review thread’s GraphQL ID, used to resolve/unresolve it; absent for conversation comments. */
  threadId?: string
  /** Whether the review thread has been resolved. Only meaningful when threadId is set. */
  isResolved?: boolean
  /** True when GitHub no longer maps the thread to the current diff. */
  isOutdated?: boolean
  /** End line of the review annotation (1-based). */
  line?: number
  /** Start line of the review annotation range (1-based). Absent for single-line comments. */
  startLine?: number
  /** Provider-reported bot identity beats login heuristics (qodo/coderabbit use varied names). Absent when non-GitHub gh fallbacks cannot report it. */
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

export type GitHubPRReviewCommentInput = {
  repoPath: string
  prRepo?: GitHubRepositoryIdentity | null
  prNumber: number
  commitId: string
  path: string
  line: number
  startLine?: number
  body: string
}
