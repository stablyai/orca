import type { JiraIssue, JiraIssueSuggestions } from '../../../shared/jira/jira-types'
import {
  buildJiraIssueKeyJql,
  buildJiraTextMatchJql
} from '../../../shared/jira/jira-search-input-jql'
import { getJiraBadRequestReason } from './task-page/jira/task-page-jira-load-state'

export type JiraIssueSearch = (
  jql: string,
  suggestions?: JiraIssueSuggestions
) => Promise<JiraIssue[]>

export async function searchJiraIssuesByKeyOrText(
  input: string,
  search: JiraIssueSearch,
  projectKey?: string
): Promise<JiraIssue[]> {
  const keyJql = buildJiraIssueKeyJql(input, projectKey)
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
  if (!projectKey && /^\d+$/.test(input.trim())) {
    return search(textJql, { query: input.trim(), currentJql: 'ORDER BY updated DESC' })
  }
  // Why: the runtime RPC rejects empty JQL.
  return textJql ? search(textJql) : []
}
