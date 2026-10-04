import type { JiraIssue } from '../../../shared/jira-types'
import { buildJiraTextMatchJql, mayBeJql } from '../../../shared/jira-search-input-jql'
import { searchJiraIssuesByKeyOrText } from './jira-key-or-text-search'
import { getJiraBadRequestReason } from './task-page-jira-load-state'

export type TaskPageJiraJqlRejection = {
  /** Jira's reason; '' when it gave none. */
  reason: string
  /** The input was written as JQL, so the reason matters more than the text matches. */
  likelyTypo: boolean
}

export type TaskPageJiraSearchResult = {
  issues: JiraIssue[]
  /** Set when Jira rejected the input as JQL and text matches are shown instead. */
  jqlRejection: TaskPageJiraJqlRejection | null
}

export async function searchTaskPageJiraIssues(
  query: string,
  search: (jql: string) => Promise<JiraIssue[]>
): Promise<TaskPageJiraSearchResult> {
  const trimmed = query.trim()
  if (!mayBeJql(trimmed)) {
    return { issues: await searchJiraIssuesByKeyOrText(trimmed, search), jqlRejection: null }
  }
  try {
    return { issues: await search(trimmed), jqlRejection: null }
  } catch (jqlError) {
    // Why: only a 400 means Jira couldn't use the query; auth, rate-limit and outages must surface.
    const reason = getJiraBadRequestReason(jqlError)
    // Input with a JQL operator is never key-shaped, so the retry is a plain text search.
    const textJql = buildJiraTextMatchJql(trimmed)
    if (reason === null || !textJql) {
      throw jqlError
    }
    const issues = await search(textJql).catch((textError: unknown) => {
      // Why: if Jira rejects the text too, the JQL reason is the useful one.
      throw getJiraBadRequestReason(textError) === null ? textError : jqlError
    })
    // Why: `=` almost never appears in a plain search (`~`, `<`, `>` do: `~/.zshrc`, `<br>`).
    return { issues, jqlRejection: { reason, likelyTypo: trimmed.includes('=') } }
  }
}
