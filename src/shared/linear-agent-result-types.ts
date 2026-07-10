import type {
  LinearErrorCode,
  LinearIncludeErrorCode,
  LinearIssueInclude,
  LinearIssueListFilter,
  LinearIssueTaskUpdateRequest
} from './linear-agent-access'
import type { LinearInlineMedia } from './linear-inline-media'

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
  dueDate?: string | null
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
  // Extracted from the full comment body before truncation so media past the
  // body cap is not lost.
  inlineMedia?: LinearInlineMedia[]
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
  inlineMedia?: LinearInlineMedia[]
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
  | 'id'
  | 'identifier'
  | 'title'
  | 'url'
  | 'state'
  | 'team'
  | 'project'
  | 'assignee'
  | 'priority'
  | 'estimate'
  | 'dueDate'
  | 'updatedAt'
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

export type LinearWriteIssueRef = {
  id: string
  identifier: string
  url: string
}

export type LinearTeamSummary = {
  id: string
  name: string
  key: string
  url?: string
  workspace?: LinearWorkspaceCandidate
}

export type LinearTeamListResult = {
  teams: LinearTeamSummary[]
  meta: {
    workspaceId?: string | 'all'
    returned: number
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
    }[]
  }
}

export type LinearTeamMembersResult = {
  team: LinearTeamSummary
  members: LinearUserSummary[]
  meta: { workspaceId: string; returned: number }
}

export type LinearTeamStatesResult = {
  team: LinearTeamSummary
  states: (LinearNamedEntity & { id: string; name: string; position: number })[]
  meta: { workspaceId: string; returned: number }
}

export type LinearTeamLabelsResult = {
  team: LinearTeamSummary
  labels: (LinearNamedEntity & { id: string; name: string })[]
  meta: { workspaceId: string; returned: number }
}

export type LinearIssueListResult = {
  issues: LinearSearchIssueSummary[]
  meta: {
    filter: LinearIssueListFilter
    workspaceId?: string | 'all'
    team?: LinearTeamSummary
    limit: number
    returned: number
    hasMore: boolean
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
    }[]
  }
}

export type LinearAgentProjectSummary = {
  id: string
  name: string
  url?: string
  workspaceId?: string
  workspaceName?: string
  teams?: {
    id: string
    name: string
    key?: string
  }[]
}

export type LinearProjectListResult = {
  projects: LinearAgentProjectSummary[]
  meta: {
    query?: string
    workspaceId?: string | 'all'
    limit: number
    returned: number
    hasMore: boolean
    partial: boolean
    workspaceErrors: {
      workspace: LinearWorkspaceCandidate
      code: LinearErrorCode
      message: string
    }[]
  }
}

export type LinearStatusSetResult = {
  issue: LinearWriteIssueRef
  state: { id: string; name: string; type: string }
  previousState: { id: string; name: string } | null
  meta: { workspaceId: string; alreadyInState: boolean }
}

export type LinearIssueTaskUpdateResult = {
  issue: LinearWriteIssueRef
  operation: LinearIssueTaskUpdateRequest['operation']
  previous: {
    assignee?: LinearUserSummary | null
    priority?: number | null
    estimate?: number | null
    dueDate?: string | null
    labels?: LinearNamedEntity[]
  }
  current: {
    assignee?: LinearUserSummary | null
    priority?: number | null
    estimate?: number | null
    dueDate?: string | null
    labels?: LinearNamedEntity[]
  }
  meta: { workspaceId: string; alreadySet: boolean }
}

export type LinearCommentAddResult = {
  comment: { id: string; url: string | null; parentId: string | null }
  issue: LinearWriteIssueRef
  meta: { workspaceId: string; bodyChars: number; writeId: string; deduplicated: boolean }
}

export type LinearAttachResult = {
  attachment: { id: string; title: string; url: string }
  issue: LinearWriteIssueRef
  meta: { workspaceId: string; writeId: string; deduplicated: boolean }
}

export type LinearCreateResult = {
  issue: {
    id: string
    identifier: string
    title: string
    url: string
    team: { id: string; key: string; name: string }
    state: { id: string; name: string } | null
    parent: { id: string; identifier: string } | null
    project?: LinearNamedEntity | null
    assignee?: LinearUserSummary | null
    priority?: number | null
    estimate?: number | null
    dueDate?: string | null
    labels?: LinearNamedEntity[]
    labelIds?: string[] | null
  }
  meta: { workspaceId: string; writeId: string; deduplicated: boolean }
}
