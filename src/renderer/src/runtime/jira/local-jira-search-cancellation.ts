import type { JiraIssue, JiraSiteSelection } from '../../../../shared/jira/jira-types'
import { searchLocalWithCancellation } from '../issue-search/local-search-cancellation'

type LocalJiraSearchArgs = { jql: string; limit?: number; siteId?: JiraSiteSelection }

export function searchLocalJiraIssues(
  args: LocalJiraSearchArgs,
  signal: AbortSignal
): Promise<JiraIssue[]> {
  return searchLocalWithCancellation({
    providerLabel: 'Jira',
    signal,
    search: (requestId) => window.api.jira.searchIssues({ ...args, requestId }),
    cancel: (requestId) => window.api.jira.cancelSearchIssues({ requestId })
  })
}
