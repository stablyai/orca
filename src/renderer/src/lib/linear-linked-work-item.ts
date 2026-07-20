import type { LinearIssue } from '../../../shared/types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { buildLinearWorkspaceSource } from '../../../shared/new-workspace/workspace-source'

export function buildLinearIssueLinkedWorkItem(issue: LinearIssue): LinkedWorkItemSummary {
  return buildLinearWorkspaceSource(issue)
}
