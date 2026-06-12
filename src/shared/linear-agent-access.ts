export const LINEAR_SEARCH_DEFAULT_LIMIT = 20
export const LINEAR_SEARCH_MAX_LIMIT = 50
export const LINEAR_COMMENTS_CAP = 500
export const LINEAR_COMMENT_BODY_CAP = 20_000
export const LINEAR_CHILDREN_DEFAULT_DEPTH = 2
export const LINEAR_CHILDREN_MAX_DEPTH = 5
export const LINEAR_CHILDREN_NODE_CAP = 200
export const LINEAR_ATTACHMENTS_CAP = 100
export const LINEAR_RELATIONS_CAP = 100

export const LINEAR_ERROR_CODES = [
  'linear_not_connected',
  'linear_issue_required',
  'linear_no_linked_issue',
  'linear_current_ambiguous',
  'linear_issue_not_found',
  'linear_workspace_ambiguous',
  'linear_invalid_workspace',
  'linear_rate_limited',
  'linear_timeout',
  'linear_permission_denied',
  'linear_auth_expired',
  'linear_network_error',
  'linear_partial'
] as const

export type LinearErrorCode = (typeof LINEAR_ERROR_CODES)[number]

export type LinearIssueInclude = 'comments' | 'children' | 'attachments' | 'relations'

export type LinearIncludeErrorCode =
  | 'linear_timeout'
  | 'linear_rate_limited'
  | 'linear_permission_denied'
  | 'linear_auth_expired'
  | 'linear_network_error'
  | 'linear_include_failed'

export type LinearIssueRequest = {
  input?: string
  current?: boolean
  workspaceId?: string
  include: Record<LinearIssueInclude, boolean>
  depth: number
  context?: LinearCurrentIssueContextHints
}

export type LinearCurrentIssueContextHints = {
  worktreeId?: string
  terminalHandle?: string
  cwd?: string
  remote?: boolean
}

export type LinearIssueSummary = {
  id: string
  identifier: string
  title: string
  url: string
  description?: string | null
  state?: LinearNamedEntity | null
  team?: (LinearNamedEntity & { key?: string | null }) | null
  project?: LinearNamedEntity | null
  cycle?: LinearNamedEntity | null
  assignee?: LinearUserSummary | null
  labels: LinearNamedEntity[]
  priority?: number | null
  estimate?: number | null
  branchName?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

export type LinearNamedEntity = {
  id?: string | null
  name?: string | null
  color?: string | null
  type?: string | null
}

export type LinearUserSummary = {
  id?: string | null
  displayName?: string | null
  avatarUrl?: string | null
}

export type LinearIssueCommentNode = {
  id: string
  body: string
  bodyTruncated: boolean
  createdAt?: string | null
  updatedAt?: string | null
  parentId?: string | null
  user?: LinearUserSummary | null
}

export type LinearIssueChildNode = LinearIssueSummary & {
  children?: LinearIssueChildNode[]
  mayHaveMore?: boolean
}

export type LinearIssueAttachment = {
  id: string
  title?: string | null
  url?: string | null
  source?: string | null
  subtitle?: string | null
  createdAt?: string | null
  metadataOnly: true
}

export type LinearIssueRelation = {
  id: string
  type?: string | null
  relatedIssue?: Pick<LinearIssueSummary, 'id' | 'identifier' | 'title' | 'url'> | null
}

export type LinearCollectionMeta = {
  returned: number
  cap: number
  capReached: boolean
  hasMore?: boolean
  mayHaveMore?: boolean
}

export type LinearIssueContextResult = {
  issue: LinearIssueSummary
  comments?: LinearIssueCommentNode[]
  children?: LinearIssueChildNode[]
  attachments?: LinearIssueAttachment[]
  relations?: LinearIssueRelation[]
  meta: {
    requested: {
      id?: string
      current: boolean
      workspaceId?: string
      include: Record<LinearIssueInclude, boolean>
      depth: number
    }
    resolved: {
      id: string
      identifier: string
      workspaceId: string
      workspaceName: string
      worktreeId?: string
      worktreePath?: string
    }
    partial: boolean
    includeErrors: {
      include: LinearIssueInclude
      code: LinearIncludeErrorCode
      message: string
    }[]
    sections: Partial<Record<LinearIssueInclude, LinearCollectionMeta>>
  }
}

export type LinearSearchIssueSummary = Pick<
  LinearIssueSummary,
  'id' | 'identifier' | 'title' | 'url' | 'state' | 'team' | 'project' | 'assignee' | 'updatedAt'
> & {
  workspace: {
    id: string
    name: string
  }
}

export type LinearSearchResult = {
  issues: LinearSearchIssueSummary[]
  meta: {
    query: string
    workspaceId?: string | 'all'
    limit: number
    returned: number
    limitReached: boolean
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
    }[]
  }
}

export type LinearWorkspaceCandidate = {
  id: string
  name: string
}

export function clampLinearSearchLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return LINEAR_SEARCH_DEFAULT_LIMIT
  }
  if (!Number.isFinite(limit)) {
    return LINEAR_SEARCH_DEFAULT_LIMIT
  }
  return Math.min(Math.max(1, Math.floor(limit)), LINEAR_SEARCH_MAX_LIMIT)
}

export function clampLinearIssueDepth(depth: number | undefined): number {
  if (depth === undefined) {
    return LINEAR_CHILDREN_DEFAULT_DEPTH
  }
  if (!Number.isFinite(depth)) {
    return LINEAR_CHILDREN_DEFAULT_DEPTH
  }
  return Math.min(Math.max(0, Math.floor(depth)), LINEAR_CHILDREN_MAX_DEPTH)
}
