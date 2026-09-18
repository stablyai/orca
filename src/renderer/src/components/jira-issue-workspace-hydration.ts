import type { JiraIssue } from '../../../shared/jira-types'

const EDITABLE_JIRA_ISSUE_FIELDS = ['title', 'labels', 'status', 'priority', 'assignee'] as const
export type EditableJiraIssueField = (typeof EDITABLE_JIRA_ISSUE_FIELDS)[number]

/** Editable fields an optimistic patch touches, including ones it clears to undefined. */
export function editedJiraIssueFields(patch: Partial<JiraIssue>): EditableJiraIssueField[] {
  return EDITABLE_JIRA_ISSUE_FIELDS.filter((field) => field in patch)
}

// Why: a detail load that started before an optimistic edit must not revert the
// edited fields; the post-save refresh brings the server's version instead.
export function mergeJiraIssueHydration(
  fetched: JiraIssue,
  current: JiraIssue | null,
  edited: ReadonlySet<EditableJiraIssueField>
): JiraIssue {
  if (edited.size === 0 || !current) {
    return fetched
  }
  return {
    ...fetched,
    title: edited.has('title') ? current.title : fetched.title,
    labels: edited.has('labels') ? current.labels : fetched.labels,
    status: edited.has('status') ? current.status : fetched.status,
    priority: edited.has('priority') ? current.priority : fetched.priority,
    assignee: edited.has('assignee') ? current.assignee : fetched.assignee
  }
}
