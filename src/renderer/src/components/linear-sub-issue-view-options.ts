import type { LinearIssueChildSummary } from '../../../shared/linear/issue-types'
import { getLinearPriorityRank } from '@/components/task-page/linear/task-page-linear-jira-list-model'

export const LINEAR_SUB_ISSUE_ORDER_BY_OPTIONS = [
  'manual',
  'status',
  'priority',
  'updated',
  'created'
] as const

export type LinearSubIssueOrderBy = (typeof LINEAR_SUB_ISSUE_ORDER_BY_OPTIONS)[number]

export type LinearSubIssueViewOptions = {
  orderBy: LinearSubIssueOrderBy
  showCompleted: boolean
}

const DEFAULT_VIEW_OPTIONS: LinearSubIssueViewOptions = { orderBy: 'manual', showCompleted: true }
const STORAGE_KEY = 'orca.linear.sub-issue-view.v1'
// Linear's workflow order; unknown types sort after the known ones.
const STATE_TYPE_RANK: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5
}
const COMPLETED_STATE_TYPES = new Set(['completed', 'canceled'])

export function isLinearSubIssueOrderBy(value: string): value is LinearSubIssueOrderBy {
  return LINEAR_SUB_ISSUE_ORDER_BY_OPTIONS.some((option) => option === value)
}

export function loadLinearSubIssueViewOptions(): LinearSubIssueViewOptions {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) {
      return DEFAULT_VIEW_OPTIONS
    }
    const orderBy = 'orderBy' in raw && typeof raw.orderBy === 'string' ? raw.orderBy : ''
    const showCompleted = 'showCompleted' in raw ? raw.showCompleted : undefined
    return {
      orderBy: isLinearSubIssueOrderBy(orderBy) ? orderBy : DEFAULT_VIEW_OPTIONS.orderBy,
      showCompleted:
        typeof showCompleted === 'boolean' ? showCompleted : DEFAULT_VIEW_OPTIONS.showCompleted
    }
  } catch {
    return DEFAULT_VIEW_OPTIONS
  }
}

export function saveLinearSubIssueViewOptions(options: LinearSubIssueViewOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options))
  } catch {
    // The live view stays usable when browser storage is unavailable or full.
  }
}

export function isCompletedLinearSubIssue(subIssue: LinearIssueChildSummary): boolean {
  return COMPLETED_STATE_TYPES.has(subIssue.state?.type ?? '')
}

function compareAscending(a: number | null | undefined, b: number | null | undefined): number {
  return (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY) || 0
}

// Negated so newer dates sort first while missing dates still sort last.
function newestFirstKey(value: string | undefined): number | undefined {
  return value ? -new Date(value).getTime() : undefined
}

function comparePrimary(
  a: LinearIssueChildSummary,
  b: LinearIssueChildSummary,
  orderBy: LinearSubIssueOrderBy
): number {
  if (orderBy === 'status') {
    return (
      compareAscending(
        STATE_TYPE_RANK[a.state?.type ?? ''],
        STATE_TYPE_RANK[b.state?.type ?? '']
      ) || compareAscending(a.state?.position, b.state?.position)
    )
  }
  if (orderBy === 'priority') {
    return getLinearPriorityRank(a.priority ?? 0) - getLinearPriorityRank(b.priority ?? 0)
  }
  if (orderBy === 'updated') {
    return compareAscending(newestFirstKey(a.updatedAt), newestFirstKey(b.updatedAt))
  }
  if (orderBy === 'created') {
    return compareAscending(newestFirstKey(a.createdAt), newestFirstKey(b.createdAt))
  }
  return 0
}

// Ties fall back to Linear's manual order, then to the order the list arrived in.
export function orderLinearSubIssues(
  subIssues: LinearIssueChildSummary[],
  options: LinearSubIssueViewOptions
): LinearIssueChildSummary[] {
  const visible = options.showCompleted
    ? subIssues
    : subIssues.filter((subIssue) => !isCompletedLinearSubIssue(subIssue))
  return [...visible].sort(
    (a, b) =>
      comparePrimary(a, b, options.orderBy) ||
      compareAscending(a.subIssueSortOrder, b.subIssueSortOrder)
  )
}
