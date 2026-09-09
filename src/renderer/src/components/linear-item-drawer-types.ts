import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

export type LinearItemDrawerProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export type LinearEditState = {
  state: LinearIssue['state']
  priority: number
  estimate: number | null | undefined
  assignee: LinearIssue['assignee']
  labelIds: string[]
  labels: string[]
}

export type LinearIssueEditSectionProps = {
  issue: LinearIssue
  editState: LinearEditState
  onEditStateChange: (patch: Partial<LinearEditState>) => void
  layout?: 'chips' | 'properties'
  sourceContext?: TaskSourceContext | null
}

export type LinearLocalComment = { id: string; body: string; createdAt: string }

export function initLinearIssueEditState(issue: LinearIssue): LinearEditState {
  return {
    state: issue.state,
    priority: issue.priority,
    estimate: issue.estimate,
    assignee: issue.assignee,
    labelIds: issue.labelIds,
    labels: issue.labels
  }
}
