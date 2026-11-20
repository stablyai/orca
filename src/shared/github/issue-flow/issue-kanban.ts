import type { IssueInfo } from '../pull-requests/pull-request-types'

export type WorkbenchKanbanColumnId = 'todo' | 'doing' | 'review' | 'done'

export const WORKBENCH_KANBAN_COLUMNS: readonly WorkbenchKanbanColumnId[] = [
  'todo',
  'doing',
  'review',
  'done'
]

const DOING_LABELS = new Set(['doing', 'in progress', 'in-progress', 'wip', 'working'])

const REVIEW_LABELS = new Set([
  'review',
  'needs review',
  'needs-review',
  'in review',
  'in-review',
  'waiting review',
  'waiting-review'
])

export function mapIssueToKanbanColumn(
  issue: Pick<IssueInfo, 'state' | 'labels'>
): WorkbenchKanbanColumnId {
  if (issue.state === 'closed') {
    return 'done'
  }
  const labels = issue.labels.map((label) => label.toLowerCase().trim())
  if (labels.some((label) => REVIEW_LABELS.has(label))) {
    return 'review'
  }
  if (labels.some((label) => DOING_LABELS.has(label))) {
    return 'doing'
  }
  return 'todo'
}

export function groupIssuesByKanbanColumn(
  issues: readonly IssueInfo[]
): Record<WorkbenchKanbanColumnId, IssueInfo[]> {
  const grouped: Record<WorkbenchKanbanColumnId, IssueInfo[]> = {
    todo: [],
    doing: [],
    review: [],
    done: []
  }
  for (const issue of issues) {
    grouped[mapIssueToKanbanColumn(issue)].push(issue)
  }
  return grouped
}
