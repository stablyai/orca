import type { RuntimeClientTarget } from '../runtime-client-target'

// Why: lists page through Jira until done; this ceiling keeps one load to about ten requests per site.
export const JIRA_ISSUE_LIST_MAX = 1000
// Why: a mapped issue is ~1.7 KB and a remote runtime replies in one message under a 1 MiB relay cap.
export const JIRA_REMOTE_ISSUE_LIST_MAX = 400

export function jiraIssueListMaxFor(target: RuntimeClientTarget | null): number {
  return target?.kind === 'environment' ? JIRA_REMOTE_ISSUE_LIST_MAX : JIRA_ISSUE_LIST_MAX
}
