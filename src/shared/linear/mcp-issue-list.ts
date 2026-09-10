import type { LinearErrorCode } from './agent-access'
import type { LinearIssueSummary, LinearWorkspaceCandidate } from './agent-result-types'

export type LinearMcpIssueListRequest = {
  team?: string
  cycle?: string
  label?: string
  limit?: number
  query?: string
  state?: string
  pageRecovery?: { version: 1; continuation?: string }
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
    // null when the caller set no --limit, capacity/time bounds still apply.
    limit: number | null
    returned: number
    hasMore: boolean
    nextCursor?: string
    pageRecovery?: {
      version: 1
      continuation: string
      ordering: 'admitted_batch'
      consistency: 'best_effort'
      stopReason?: string
    }
    concreteRecovery?: { workspaceId: string; cursor?: string; done: boolean }[]
    omittedWorkspaceErrors?: number
    orderBy: 'createdAt' | 'updatedAt'
    workspaceId?: (string & {}) | 'all'
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
      data?: unknown
    }[]
  }
}
