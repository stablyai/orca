import type { LinearErrorCode } from './agent-access'
import type { LinearIssueSummary, LinearWorkspaceCandidate } from './agent-result-types'

export type LinearMcpIssueListRequest = {
  team?: string
  cycle?: string
  label?: string
  limit?: number
  query?: string
  state?: string
  cursor?: string
  orderBy?: 'createdAt' | 'updatedAt'
  project?: string
  release?: string
  assignee?: string
  delegate?: string
  parentId?: string
  priority?: number
  createdAt?: string
  updatedAt?: string
  includeArchived?: boolean
  workspaceId?: (string & {}) | 'all'
}

export type LinearMcpIssueListResult = {
  issues: (LinearIssueSummary & { workspace: LinearWorkspaceCandidate })[]
  // Optional on the wire: a remote host that predates the field sends nothing, and readers
  // must fall back to meta rather than read absence as "complete".
  truncated?: boolean
  meta: {
    // null when the caller set no --limit, i.e. every matching issue was read.
    limit: number | null
    returned: number
    hasMore: boolean
    nextCursor?: string
    orderBy: 'createdAt' | 'updatedAt'
    workspaceId?: (string & {}) | 'all'
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
    }[]
  }
}
