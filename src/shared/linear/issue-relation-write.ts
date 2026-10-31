import type { LinearCurrentIssueContextHints } from './agent-access'
import type {
  LinearIssueRelation,
  LinearIssueSummary,
  LinearWriteIssueRef
} from './agent-result-types'

export type LinearIssueRelationship = 'blocks' | 'blockedBy' | 'relatedTo' | 'duplicateOf'

export type LinearRelationIssueRef = LinearWriteIssueRef & Pick<LinearIssueSummary, 'title'>

export type LinearIssueRelationWriteRequest = {
  input?: string
  current?: boolean
  workspaceId?: string
  context?: LinearCurrentIssueContextHints
  relatedInput: string
  relationship: LinearIssueRelationship
  operation: 'add' | 'remove'
}

export type LinearIssueRelationWriteResult = {
  issue: LinearRelationIssueRef
  relatedIssue: LinearRelationIssueRef
  relation: LinearIssueRelation
  operation: 'add' | 'remove'
  meta: { workspaceId: string; alreadySet: boolean }
}
