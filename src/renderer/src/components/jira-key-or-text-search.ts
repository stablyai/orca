import type { JiraIssue } from '../../../shared/jira/jira-types'
import {
  buildJiraIssueKeysJql,
  buildJiraTextMatchJql,
  listJiraIssueKeyCandidates
} from '../../../shared/jira/jira-search-input-jql'
import { getJiraBadRequestReason } from './task-page/jira/task-page-jira-load-state'

const MAX_KEY_LOOKUPS = 5

export async function searchJiraIssuesByKeyOrText(
  input: string,
  search: (jql: string) => Promise<JiraIssue[]>,
  projectKeys?: readonly string[]
): Promise<JiraIssue[]> {
  let keys = listJiraIssueKeyCandidates(input, projectKeys)
  for (let lookup = 0; lookup < MAX_KEY_LOOKUPS && keys.length > 0; lookup += 1) {
    try {
      const issues = await search(buildJiraIssueKeysJql(keys))
      if (issues.length > 0) {
        return issues
      }
      break
    } catch (error) {
      // Key-shaped text such as utf-8 can yield a 400; it doesn't rule out a text match.
      const reason = getJiraBadRequestReason(error)
      if (reason === null) {
        throw error
      }
      // Why: Server/DC rejects all of `key in (…)` over one missing key, naming it; retry the rest.
      const remaining = keys.filter((key) => !reason.includes(`'${key}'`))
      if (remaining.length === keys.length) {
        break
      }
      keys = remaining
    }
  }
  const textJql = buildJiraTextMatchJql(input)
  // Why: the runtime RPC rejects empty JQL.
  return textJql ? search(textJql) : []
}
