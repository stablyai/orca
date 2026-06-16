export const LINEAR_SEARCH_DEFAULT_LIMIT = 20
export const LINEAR_SEARCH_MAX_LIMIT = 50
export const LINEAR_COMMENTS_CAP = 500
export const LINEAR_COMMENT_BODY_CAP = 20_000
export const LINEAR_CHILDREN_DEFAULT_DEPTH = 2
export const LINEAR_CHILDREN_MAX_DEPTH = 5
export const LINEAR_CHILDREN_NODE_CAP = 200
export const LINEAR_ATTACHMENTS_CAP = 100
export const LINEAR_RELATIONS_CAP = 100
export const LINEAR_WRITE_BODY_CAP = 65_000

export const LINEAR_ERROR_CODES = [
  'linear_not_connected',
  'linear_issue_required',
  'linear_no_linked_issue',
  'linear_current_ambiguous',
  'linear_issue_not_found',
  'linear_workspace_ambiguous',
  'linear_invalid_workspace',
  'linear_invalid_state',
  'linear_invalid_assignee',
  'linear_invalid_label',
  'linear_invalid_parent',
  'linear_team_required',
  'linear_invalid_url',
  'linear_body_too_large',
  'linear_invalid_write_id',
  'linear_write_failed',
  'linear_write_unconfirmed',
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

export type {
  LinearAttachResult,
  LinearCollectionMeta,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearIssueAttachment,
  LinearIssueChildNode,
  LinearIssueCommentNode,
  LinearIssueContextResult,
  LinearIssueListResult,
  LinearIssueRelation,
  LinearIssueSummary,
  LinearNamedEntity,
  LinearSearchIssueSummary,
  LinearSearchResult,
  LinearStatusSetResult,
  LinearTeamLabelsResult,
  LinearTeamListResult,
  LinearTeamMembersResult,
  LinearTeamStatesResult,
  LinearTeamSummary,
  LinearUserSummary,
  LinearWorkspaceCandidate,
  LinearWriteIssueRef,
  LinearIssueTaskUpdateResult
} from './linear-agent-result-types'

export type LinearWriteTargetRequest = {
  input?: string
  current?: boolean
  workspaceId?: string
  context?: LinearCurrentIssueContextHints
}

export type LinearTeamDiscoveryRequest = {
  teamInput?: string
  workspaceId?: string | 'all'
}

export type LinearIssueListFilter = 'assigned' | 'created' | 'all' | 'completed' | 'open'

export type LinearIssueListRequest = {
  filter?: LinearIssueListFilter
  teamInput?: string
  limit?: number
  workspaceId?: string | 'all'
}

export type LinearStatusSetRequest = LinearWriteTargetRequest & {
  to: string
}

export type LinearIssueTaskUpdateRequest = LinearWriteTargetRequest & {
  operation: 'assignee' | 'priority' | 'estimate' | 'dueDate' | 'labels'
  assigneeId?: string | null
  assigneeMe?: boolean
  priority?: number
  estimate?: number | null
  dueDate?: string | null
  labelMode?: 'add' | 'remove' | 'set'
  labels?: string[]
}

export type LinearCommentAddRequest = LinearWriteTargetRequest & {
  body: string
  replyTo?: string
  writeId?: string
}

export type LinearAttachRequest = LinearWriteTargetRequest & {
  url: string
  title?: string
  writeId?: string
}

export type LinearCreateRequest = {
  title: string
  body?: string
  teamInput?: string
  teamKey?: string
  state?: string
  assignee?: string
  priority?: number
  estimate?: number
  dueDate?: string
  labels?: string[]
  parentInput?: string
  parentCurrent?: boolean
  workspaceId?: string
  writeId?: string
  context?: LinearCurrentIssueContextHints
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
