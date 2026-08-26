import type { LinearIssueTaskUpdateRequest } from './agent-access'
import type {
  LinearNamedEntity,
  LinearUserSummary,
  LinearWriteIssueRef
} from './agent-result-types'

export type LinearIssueTaskUpdateResult = {
  issue: LinearWriteIssueRef
  operation: LinearIssueTaskUpdateRequest['operation']
  previous: LinearTaskFieldValues
  current: LinearTaskFieldValues
  meta: { workspaceId: string; alreadySet: boolean }
}

type LinearTaskFieldValues = {
  assignee?: LinearUserSummary | null
  priority?: number | null
  estimate?: number | null
  dueDate?: string | null
  labels?: LinearNamedEntity[]
  cycle?: LinearNamedEntity | null
}
