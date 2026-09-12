export type GitHubCreateIssueFields = {
  labels?: string[]
  assignees?: string[]
}

export type GitHubCreateIssueResult =
  | { ok: true; number: number; url: string; bodySaveWarning?: string }
  | { ok: false; error: string }

export type GitHubIssueCloseReason = 'completed' | 'not_planned' | 'duplicate'

export type GitHubIssueUpdate = {
  state?: 'open' | 'closed'
  stateReason?: GitHubIssueCloseReason
  duplicateOf?: number
  title?: string
  // Why: body writes use the REST issue endpoint instead of `gh issue edit`
  // because that command does not consistently cover every body-edit case the
  // dialog needs.
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}

export type GitHubPullRequestStateUpdate = {
  state: 'open' | 'closed'
}

export type LinearIssueUpdate = {
  stateId?: string
  title?: string
  description?: string
  assigneeId?: string | null
  estimate?: number | null
  priority?: number
  dueDate?: string | null
  labelIds?: string[]
  projectId?: string | null
  parentId?: string | null
}
