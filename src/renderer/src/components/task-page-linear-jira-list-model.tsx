import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import {
  type LinearOrderBy,
  type LinearGroupBy,
  getLinearPriorityLabel,
  type LinearDisplayProperty
} from '@/components/task-page-localized-options'
import { translate } from '@/i18n/i18n'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import React from 'react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TaskPageGitHubMutationIntent } from '@/components/task-page-github-work-item-mutation-patches'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { LinearGroupSection } from './task-page-linear-issue-model'
import { compareNumericLocaleText } from '@/lib/locale-text-collators'
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
      label: issue.assignee?.displayName ?? 'Unassigned'
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
    label: translate('auto.components.TaskPage.dfc0c79bd8', 'Issues')
  }
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
      sections.set(group.key, {
        key: group.key,
        label: group.label,
        issues: [issue]
      })
    }
  }
  return [...sections.values()]
}
export function TaskPageJiraErrorBanner({
  error,
  open,
  onOpenChange
}: {
  error: TaskPageJiraLoadError
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 flex-none" />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-5">{error.title}</div>
          {error.details ? (
            <>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="-ml-1 mt-1 h-6 px-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {translate('auto.components.TaskPage.40eaf2c27c', 'Details')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 rounded-md border border-destructive/20 bg-background/80 px-2 py-1.5 font-mono text-xs text-foreground">
                  {error.details}
                </div>
              </CollapsibleContent>
            </>
          ) : null}
        </div>
      </div>
    </Collapsible>
  )
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
export type TaskPageGitHubWorkItemMutationRunner = {
  run: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
    mutate: () => Promise<{
      ok?: boolean
      error?:
        | string
        | {
            message?: string
          }
    } | void>
    successToast?: string
    errorToast: string
  }) => Promise<'confirmed' | 'rolled_back' | 'stale'>
  isIntentPending: (input: {
    item: GitHubWorkItem
    intent: TaskPageGitHubMutationIntent
    sourceContext?: TaskSourceContext | null
  }) => boolean
}
