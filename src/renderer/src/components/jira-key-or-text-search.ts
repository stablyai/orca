import type { JiraIssue } from '../../../shared/jira-types'
import { buildJiraIssueKeyJql, buildJiraTextMatchJql } from '../../../shared/jira-search-input-jql'
import { getJiraBadRequestReason } from './task-page-jira-load-state'

/** Find the issue with this key, or failing that, issues whose text matches the input. */
export async function searchJiraIssuesByKeyOrText(
  input: string,
  search: (jql: string) => Promise<JiraIssue[]>
): Promise<JiraIssue[]> {
  const keyJql = buildJiraIssueKeyJql(input)
  if (keyJql) {
    // Why: `utf-8` is key-shaped but meant as text. Jira answers a key it doesn't have with
    // no issues (unknown project) or a 400 (unknown number), so neither is a final answer.
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
