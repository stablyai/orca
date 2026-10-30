import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import { getUsableLinearBranchName } from '../../../shared/new-workspace/workspace-source'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function formatLinearIssueRelativeTime(input: string): string {
  return formatUiRelativeTimeFromDate(input)
}

export function buildLinearIssueBranchName(issue: LinearIssue): string {
  return getUsableLinearBranchName(issue.branchName) ?? getLinearIssueWorkspaceName(issue)
}
