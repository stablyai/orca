import { isRuntimeProviderSearchQueryWithinLimit } from '@/runtime/runtime-provider-search-bounds'
import type { JiraIssue, JiraProject } from '../../../../../shared/jira/jira-types'
import { withCurrentSprintClause } from '../../../../../shared/jira/jira-jql-predicate'
import {
  restrictJiraQueryToProject,
  type JiraProjectReference
} from '../../../../../shared/jira/jira-project-reference'
import {
  buildJiraIssueKeyJql,
  buildJiraTextMatchJql,
  mayBeJql
} from '../../../../../shared/jira/jira-search-input-jql'
import { searchJiraIssuesByKeyOrText } from '../../jira-key-or-text-search'
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
  search: (jql: string) => Promise<JiraIssue[]>,
  mode: 'input' | 'jql' = 'input',
  projectKeys?: readonly string[]
): Promise<TaskPageJiraSearchResult> {
  const trimmed = query.trim()
  if (mode === 'jql') {
    return { issues: await search(trimmed), jqlRejection: null }
  }
  if (!mayBeJql(trimmed)) {
    return {
      issues: await searchJiraIssuesByKeyOrText(trimmed, search, projectKeys),
      jqlRejection: null
    }
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

/**
 * Searches within the sprint and project scope. A bare number is also looked up as a key in the
 * selected project, or else in each of `projects`.
 */
export function searchScopedTaskPageJiraIssues(
  query: string,
  search: (jql: string) => Promise<JiraIssue[]>,
  mode: 'input' | 'jql',
  currentSprint: boolean,
  projectFilter: JiraProjectReference | null,
  projects: readonly JiraProject[] | null
): Promise<TaskPageJiraSearchResult> {
  const scopeJql = (jql: string) => {
    const sprintJql = currentSprint ? withCurrentSprintClause(jql) : jql
    return projectFilter ? restrictJiraQueryToProject(sprintJql, projectFilter) : sprintJql
  }
  const projectKeys = projectFilter
    ? [projectFilter.key]
    : (projects ?? []).map((project) => project.key)
  const keyJql = buildJiraIssueKeyJql(query, projectKeys)
  // Why: an oversized key lookup would fail the whole search, so search the text alone.
  const keyLookupFits = !keyJql || isRuntimeProviderSearchQueryWithinLimit(scopeJql(keyJql))
  return searchTaskPageJiraIssues(
    query,
    (jql) => search(scopeJql(jql)),
    mode,
    keyLookupFits ? projectKeys : []
  )
}
