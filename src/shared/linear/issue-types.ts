import type { LinearProjectSummary } from './project-types'

export type LinearIssue = {
  id: string
  workspaceId?: string
  workspaceName?: string
  identifier: string
  title: string
  branchName?: string
  description?: string
  url: string
  state: {
    name: string
    type: string
    color: string
  }
  team: {
    id: string
    name: string
    key: string
  }
  project?: LinearProjectSummary
  subIssues?: LinearIssueChildSummary[]
  labels: string[]
  labelIds: string[]
  assignee?: {
    id: string
    displayName: string
    avatarUrl?: string
  }
  estimate?: number | null
  priority: number
  dueDate?: string | null
  updatedAt: string
}

export type LinearIssueChildSummary = {
  id: string
  identifier: string
  title: string
  url: string
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  user?: {
    displayName: string
    avatarUrl?: string
  }
}
