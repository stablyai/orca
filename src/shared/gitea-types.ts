import type { ExecutionHostId } from './execution-host'
import type { ClassifiedError } from './classified-error'
import type { CheckStatus, PRMergeableState } from './github/pull-request-types'
import type { MRComment } from './gitlab-types'

export type GiteaKnownLogin = {
  name: string
  url: string
  host: string
  sshHost: string
  user: string
  isDefault: boolean
}

export type GiteaViewer = {
  username: string
  email: string | null
}

export type GiteaAuthDiagnostic = {
  teaAvailable: boolean
  authenticated: boolean
  hosts: string[]
  activeHost: string | null
  logins: readonly GiteaKnownLogin[]
  envTokenInProcess: 'ORCA_GITEA_TOKEN' | 'GITEA_TOKEN' | null
  error: string | null
}

export type GiteaRateLimitBucket = {
  limit: number
  remaining: number
  resetAt: number | null
}

export type GiteaRateLimitSnapshot = {
  rest: GiteaRateLimitBucket | null
  host: string | null
  fetchedAt: number
}

export type GetGiteaRateLimitResult =
  | { ok: true; snapshot: GiteaRateLimitSnapshot }
  | { ok: false; error: string }

export type GiteaProjectRef = {
  host: string
  path: string
}

export type GiteaPullRequestState = 'open' | 'closed' | 'merged' | 'draft'

export type GiteaPullRequestInfo = {
  number: number
  title: string
  state: GiteaPullRequestState
  url: string
  status: CheckStatus
  updatedAt: string
  mergeable: PRMergeableState
  headSha?: string
}

export type GiteaWorkItem = {
  id: string
  type: 'issue' | 'pr'
  number: number
  title: string
  state: GiteaPullRequestState
  url: string
  labels: string[]
  updatedAt: string
  author: string | null
  branchName?: string
  baseRefName?: string
  headSha?: string
  isCrossRepository?: boolean
  repoId: string
  /** Stamped by the renderer so a twin's two rows keep distinct identities. */
  repoHostId?: ExecutionHostId
}

export type GiteaIssueInfo = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  url: string
  author: string | null
  labels: string[]
  assignees: string[]
  updatedAt: string
}

export type GiteaIssueListState = 'opened' | 'closed' | 'all'

export type GiteaIssueListResult = {
  items: GiteaIssueInfo[]
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  error?: ClassifiedError
}

export type GiteaPagedResult<T> = {
  items: T[]
  page: number
  perPage: number
  totalCount: number
  totalPages: number
  error?: ClassifiedError
}

export type PRListState = 'opened' | 'closed' | 'merged' | 'all'

export type ListGiteaPullRequestsResult = GiteaPagedResult<GiteaWorkItem>

export type GiteaIssueUpdate = {
  state?: 'open' | 'closed'
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type GiteaPRUpdate = {
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  /** True marks the pull request draft; false marks it ready for review. */
  draft?: boolean
}

export type GiteaPRFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'renamed' | 'deleted'
  additions: number
  deletions: number
  isBinary: boolean
  diff?: string
}

export type GiteaAssignableUser = {
  id?: number
  username: string
  name: string | null
  avatarUrl: string
}

export type GiteaApprovalState = {
  approvedBy: GiteaAssignableUser[]
  changesRequested: boolean
}

export type GiteaPipelineJob = {
  id: number
  runId?: number
  name: string
  stage: string
  status: string
  webUrl: string
  duration: number | null
}

export type GiteaWorkItemDetails = {
  item: Omit<GiteaWorkItem, 'repoId'>
  body: string
  comments: MRComment[]
  headSha?: string
  baseSha?: string
  files?: GiteaPRFile[]
  reviewers?: GiteaAssignableUser[]
  approvalState?: GiteaApprovalState
  assignees?: string[]
  pipelineJobs?: GiteaPipelineJob[]
}

export type GiteaNotification = {
  id: number
  subjectType: string
  subjectTitle: string
  subjectUrl: string
  subjectNumber: number | null
  repositoryPath: string
  updatedAt: string
  unread: boolean
}

export type GiteaMutationFailure = { ok: false; error: string }

export type GiteaMutationResult = { ok: true } | GiteaMutationFailure

export type GiteaCommentResult = { ok: true; comment: MRComment } | GiteaMutationFailure

export type GiteaDiscussionResolveResult = GiteaMutationResult

export type GiteaPRReviewersUpdateResult = { ok: true; reviewers: string[] } | GiteaMutationFailure

export type GiteaPRInlineCommentInput = {
  body: string
  path: string
  line: number
  headSha: string
  replyToCommentId?: string
}

export type GiteaMergeStyle = 'merge' | 'squash' | 'rebase' | 'rebase-merge'

export type GiteaIssueCreateResult =
  | { ok: true; number: number; url: string }
  | GiteaMutationFailure

export type GiteaJobTraceResult =
  | { ok: true; trace: string }
  | { ok: false; error: string; errorCode?: string }

export type GiteaReviewDecision = 'approve' | 'request_changes'
