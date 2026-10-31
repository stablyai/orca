import type { LinearIssue } from '../../../../shared/linear/issue-types'

export type LinearIssueDisplayLabel = { id?: string; name: string; color?: string }

// Why: same-named labels can differ, and optimistic edits may leave labelIds and labelDetails behind labels.
export function getLinearIssueDisplayLabels(
  issue: Pick<LinearIssue, 'labels' | 'labelIds' | 'labelDetails'>
): LinearIssueDisplayLabel[] {
  return issue.labels.map((name, index) => {
    const id = issue.labelIds[index]
    const detail = issue.labelDetails?.find((label) => label.id === id)
    return detail && detail.name !== name ? { name } : { id, name, color: detail?.color }
  })
}

export function getLinearIssueDisplayLabelKey(
  label: LinearIssueDisplayLabel,
  index: number
): string {
  return label.id ?? `${label.name}:${index}`
}
