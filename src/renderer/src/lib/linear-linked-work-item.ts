import type { LinearIssue } from '../../../shared/types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { buildLinearIssueContextSnapshot } from '@/lib/linear-issue-context-snapshot'

export function buildLinearIssueLinkedWorkItem(
  issue: LinearIssue,
  renderedText = buildLinearIssueContextSnapshot(issue)
): LinkedWorkItemSummary {
  return {
    type: 'issue',
    // Why: Linear issue identifiers are strings; keep numeric issue metadata
    // empty while preserving the real source through `linearIdentifier`.
    number: 0,
    title: issue.title,
    url: issue.url,
    linearIdentifier: issue.identifier,
    ...(renderedText.trim()
      ? {
          linkedContext: {
            provider: 'linear' as const,
            version: 1 as const,
            renderedText
          }
        }
      : {})
  }
}
