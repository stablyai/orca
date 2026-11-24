import type { JiraIssue } from './jira-types'
import { buildJiraIssueKeyJql, buildJiraTextMatchJql, mayBeJql } from './jira-search-input-jql'
import { parseJiraStatusError } from './jira-status-error'

export type JiraJqlRejection = {
  /** Jira's reason; '' when it gave none. */
  reason: string
  /** The input was written as JQL, so the reason matters more than the text matches. */
  likelyTypo: boolean
}

export type JiraInputSearchResult = {
  issues: JiraIssue[]
  /** Set when Jira rejected the input as JQL and text matches are shown instead. */
  jqlRejection: JiraJqlRejection | null
}

/** Jira's reason when it rejected the request as malformed (HTTP 400); null for other failures. */
export function getJiraBadRequestReason(error: unknown): string | null {
  const status = error instanceof Error ? parseJiraStatusError(error.message) : null
  return status?.code === 400 ? status.details : null
}

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

/** Search what a user typed: a key or text, or JQL that falls back to text when Jira rejects it. */
export async function searchJiraIssuesByInput(
  query: string,
  search: (jql: string) => Promise<JiraIssue[]>,
  mode: 'input' | 'jql' = 'input'
): Promise<JiraInputSearchResult> {
  const trimmed = query.trim()
  if (mode === 'jql') {
    return { issues: await search(trimmed), jqlRejection: null }
  }
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
