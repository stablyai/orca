import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type {
  LinearOrderBy,
  LinearGroupBy
} from '../../../../../../shared/linear/issue-view-resume-state'
import { getLinearPriorityLabel } from '../../task-page-localized-options'
import { translate } from '../../../../i18n/i18n'
import { compareNumericLocaleText } from '../../../../../../shared/locale-text-collators'
import type { Translate } from '../../../../i18n/use-translate'

export type LinearGroupSection = {
  key: string
  label: string
  issues: LinearIssue[]
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
  groupBy: LinearGroupBy,
  t: Translate = translate
): {
  key: string
  label: string
} {
  if (groupBy === 'status') {
    return {
      key: `status:${issue.state.name}`,
      label: issue.state.name
    }
  }
  if (groupBy === 'assignee') {
    return {
      key: `assignee:${issue.assignee?.id ?? 'unassigned'}`,
      label:
        issue.assignee?.displayName ?? t('auto.components.TaskPage.groupUnassigned', 'Unassigned')
    }
  }
  if (groupBy === 'priority') {
    return {
      key: `priority:${issue.priority}`,
      label: getLinearPriorityLabel(issue.priority)
    }
  }
  if (groupBy === 'team') {
    return {
      key: `team:${issue.team.id}`,
      label: issue.team.name
    }
  }
  return {
    key: 'all',
    label: t('auto.components.TaskPage.dfc0c79bd8', 'Issues')
  }
}

export function groupLinearIssues(
  issues: LinearIssue[],
  groupBy: LinearGroupBy,
  orderBy: LinearOrderBy,
  t: Translate = translate
): LinearGroupSection[] {
  const sorted = [...issues].sort((a, b) => compareLinearIssues(a, b, orderBy))
  if (groupBy === 'none') {
    return [
      {
        key: 'all',
        label: t('auto.components.TaskPage.dfc0c79bd8', 'Issues'),
        issues: sorted
      }
    ]
  }
  const sections = new Map<string, LinearGroupSection>()
  for (const issue of sorted) {
    const group = getLinearIssueGroup(issue, groupBy, t)
    const section = sections.get(group.key)
    if (section) {
      section.issues.push(issue)
    } else {
      sections.set(group.key, {
        key: group.key,
        label: group.label,
        issues: [issue]
      })
    }
  }
  return [...sections.values()]
}
