import type { JiraIssue } from '../../../shared/jira/jira-types'
import {
  buildJiraIssueKeyJql,
  buildJiraTextMatchJql
} from '../../../shared/jira/jira-search-input-jql'
import { getJiraBadRequestReason } from './task-page/jira/task-page-jira-load-state'

export async function searchJiraIssuesByKeyOrText(
  input: string,
  search: (jql: string) => Promise<JiraIssue[]>
): Promise<JiraIssue[]> {
  const keyJql = buildJiraIssueKeyJql(input)
  if (keyJql) {
    // Key-shaped text such as utf-8 can yield an empty result or 400; neither rules out a text match.
    const issues = await search(keyJql).catch((error: unknown) => {
      if (getJiraBadRequestReason(error) === null) {
        throw error
      }
      return []
    })
    if (issues.length > 0) {
      return issues
    }
  }
  const textJql = buildJiraTextMatchJql(input)
  // Why: the runtime RPC rejects empty JQL.
  return textJql ? search(textJql) : []
}
