import type { LinearErrorCode } from './linear-agent-access'
import type { LinearIssueSummary, LinearWorkspaceCandidate } from './linear-agent-result-types'

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
  workspaceId?: string | 'all'
}

export type LinearMcpIssueListResult = {
  issues: (LinearIssueSummary & { workspace: LinearWorkspaceCandidate })[]
  meta: {
    limit: number
    returned: number
    hasMore: boolean
    nextCursor?: string
    orderBy: 'createdAt' | 'updatedAt'
    workspaceId?: string | 'all'
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
    }[]
  }
}
