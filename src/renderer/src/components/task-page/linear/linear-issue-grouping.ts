import { compareNumericLocaleText } from '@/lib/locale-text-collators'
import { translate } from '@/i18n/i18n'
import {
  getLinearPriorityLabel,
  type LinearDisplayProperty,
  type LinearGroupBy,
  type LinearOrderBy
} from '@/components/task-page-localized-options'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearCustomViewModel } from '../../../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearWorkflowState
} from '../../../../../shared/linear/workspace-types'

export type LinearProjectTab = 'overview' | 'issues'

export type LinearGroupSection = {
  key: string
  label: string
  issues: LinearIssue[]
}

export type LinearIssueListRow =
  | { type: 'section'; key: string; label: string; count: number }
  | { type: 'issue'; issue: LinearIssue }

export const LINEAR_CUSTOM_VIEW_MODELS = [
  'issue',
  'project'
] satisfies readonly LinearCustomViewModel[]

export function mergeLinearCollectionResults<T>(
  results: LinearCollectionResult<T>[]
): LinearCollectionResult<T> {
  const errors = results.flatMap((result) => result.errors ?? [])
  return {
    items: results.flatMap((result) => result.items),
    ...(errors.length > 0 ? { errors } : {}),
    ...(results.some((result) => result.hasMore) ? { hasMore: true } : {})
  }
}

export function getLinearStatusSectionState(
  section: LinearGroupSection
): LinearIssue['state'] | null {
  if (!section.key.startsWith('status:')) {
    return null
  }
  return section.issues[0]?.state ?? null
}

export function findLinearWorkflowStateForStatus(
  states: LinearWorkflowState[],
  targetState: LinearIssue['state']
): LinearWorkflowState | undefined {
  return (
    states.find((state) => state.name === targetState.name && state.type === targetState.type) ??
    states.find((state) => state.name === targetState.name)
  )
}

export function getLinearPriorityRank(priority: number): number {
  return priority === 0 ? 5 : priority
}

export function compareLinearIssues(
  a: LinearIssue,
  b: LinearIssue,
  orderBy: LinearOrderBy
): number {
  if (orderBy === 'updated') {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  }
  if (orderBy === 'identifier') {
    return compareNumericLocaleText(a.identifier, b.identifier)
  }

  const priorityDelta = getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority)
  if (priorityDelta !== 0) {
    return priorityDelta
  }
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
}

export function getLinearIssueGroup(
  issue: LinearIssue,
  groupBy: LinearGroupBy
): { key: string; label: string } {
  if (groupBy === 'status') {
    return { key: `status:${issue.state.name}`, label: issue.state.name }
  }
  if (groupBy === 'assignee') {
    return {
      key: `assignee:${issue.assignee?.id ?? 'unassigned'}`,
      label:
        issue.assignee?.displayName ??
        translate('auto.components.TaskPage.42a9160321', 'Unassigned')
    }
  }
  if (groupBy === 'priority') {
    return {
      key: `priority:${issue.priority}`,
      label: getLinearPriorityLabel(issue.priority)
    }
  }
  if (groupBy === 'team') {
    return { key: `team:${issue.team.id}`, label: issue.team.name }
  }
  return { key: 'all', label: translate('auto.components.TaskPage.dfc0c79bd8', 'Issues') }
}

export function groupLinearIssues(
  issues: LinearIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy
): LinearGroupSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [
      {
        key: 'all',
        label: translate('auto.components.TaskPage.dfc0c79bd8', 'Issues'),
        issues: sorted
      }
    ]
  }

  const sections = new Map<string, LinearGroupSection>()
  for (const issue of sorted) {
    const group = getLinearIssueGroup(issue, groupBy)
    const section = sections.get(group.key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(group.key, { key: group.key, label: group.label, issues: [issue] })
    }
  }
  return [...sections.values()]
}

export function getLinearIssueGridTemplate(
  visibleProperties: ReadonlySet<LinearDisplayProperty>
): string {
  const columns = ['96px', 'minmax(240px,1.55fr)']
  if (visibleProperties.has('labels')) {
    columns.push('minmax(168px,0.9fr)')
  }
  if (visibleProperties.has('team')) {
    columns.push('minmax(172px,0.9fr)')
  }
  if (visibleProperties.has('state')) {
    columns.push('138px')
  }
  if (visibleProperties.has('assignee')) {
    columns.push('64px')
  }
  if (visibleProperties.has('updated')) {
    columns.push('104px')
  }
  // Why: Worktrees is icon-only (open vs start); keep it narrow so issue title keeps the room.
  columns.push('64px')
  return columns.join(' ')
}
