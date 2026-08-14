export type LinearProjectSummary = {
  id: string
  slugId?: string
  workspaceId?: string
  workspaceName?: string
  name: string
  url?: string
  color?: string
  icon?: string
  description?: string
  content?: string
  status?: LinearProjectStatusSummary
  health?: string | null
  priority?: number | null
  priorityLabel?: string | null
  lead?: LinearProjectMemberSummary
  members?: LinearProjectMemberSummary[]
  teams?: {
    id: string
    name: string
    key?: string
  }[]
  labels?: {
    id: string
    name: string
    color?: string
  }[]
  startDate?: string | null
  targetDate?: string | null
  createdAt?: string
  updatedAt?: string
  completedAt?: string | null
  canceledAt?: string | null
  startedAt?: string | null
  progress?: number | null
  scope?: number | null
  issueCount?: number
  completedIssueCount?: number
}

export type LinearProjectStatusSummary = {
  id: string
  name: string
  type?: string
  color?: string
}

export type LinearProjectMemberSummary = {
  id: string
  displayName: string
  avatarUrl?: string
}

export type LinearProjectMilestoneSummary = {
  id: string
  name: string
  status?: string
  targetDate?: string | null
  progress?: number | null
}

export type LinearProjectResourceSummary = {
  id: string
  title: string
  url: string
  type?: string
}

export type LinearProjectUpdateSummary = {
  id: string
  body?: string
  health?: string | null
  url?: string
  createdAt?: string
  updatedAt?: string
  user?: LinearProjectMemberSummary
}

export type LinearProjectDetail = LinearProjectSummary & {
  milestones?: LinearProjectMilestoneSummary[]
  resources?: LinearProjectResourceSummary[]
  latestUpdate?: LinearProjectUpdateSummary
}

export type LinearCustomViewModel = 'issue' | 'project'

export type LinearCustomViewSummary = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  description?: string
  model: LinearCustomViewModel
  url?: string
  color?: string
  icon?: string
  shared?: boolean
  team?: {
    id: string
    name?: string
    key?: string
  }
  owner?: LinearProjectMemberSummary
  creator?: LinearProjectMemberSummary
  createdAt?: string
  updatedAt?: string
}
