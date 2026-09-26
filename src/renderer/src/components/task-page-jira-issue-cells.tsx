import React from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraIssue } from '../../../shared/jira-types'
import {
  formatJiraEstimate,
  formatJiraStoryPoints,
  type JiraListColumnId
} from './jira-list-columns'
import { getJiraPriorityTone } from './task-page-jira-status-tone'

const MUTED_CELL = 'block truncate text-[12px] text-muted-foreground'

export function noPriorityLabel(): string {
  return translate('auto.components.TaskPage.713179dfdc', 'No priority')
}

export function unassignedLabel(): string {
  return translate('auto.components.TaskPage.42a9160321', 'Unassigned')
}

export function JiraPriorityText({
  issue,
  className
}: {
  issue: JiraIssue
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn(getJiraPriorityTone(issue.priority?.name), className)}>
      {issue.priority?.name ?? noPriorityLabel()}
    </span>
  )
}

function ParentCell({ issue }: { issue: JiraIssue }): React.JSX.Element {
  if (!issue.parent) {
    return <span className={MUTED_CELL}>–</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="shrink-0 rounded-sm border border-primary/30 bg-primary/10 px-1 font-mono text-[10px] text-primary">
            {issue.parent.key}
          </span>
          <span className="truncate">{issue.parent.title}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {issue.parent.issueTypeName ? `${issue.parent.issueTypeName}: ` : ''}
        {issue.parent.title}
      </TooltipContent>
    </Tooltip>
  )
}

function AssigneeCell({ issue }: { issue: JiraIssue }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
      {issue.assignee?.avatarUrl ? (
        <img
          src={issue.assignee.avatarUrl}
          alt={issue.assignee.displayName}
          className="size-5 shrink-0 rounded-full"
        />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px]">
          {issue.assignee?.displayName?.slice(0, 1) ?? '-'}
        </span>
      )}
      <span className="truncate">{issue.assignee?.displayName ?? unassignedLabel()}</span>
    </div>
  )
}

/** Desktop cell for every column except `key` and `title`, which the row renders itself. */
export function JiraIssueCell({
  column,
  issue,
  formatUpdatedAt,
  getStatusTone
}: {
  column: JiraListColumnId
  issue: JiraIssue
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (categoryKey: string) => string
}): React.JSX.Element | null {
  switch (column) {
    case 'status':
      return (
        <div className="flex min-w-0">
          <span
            className={cn(
              'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
              getStatusTone(issue.status.categoryKey)
            )}
          >
            <span className="truncate">{issue.status.name}</span>
          </span>
        </div>
      )
    case 'priority':
      return <JiraPriorityText issue={issue} className="block truncate text-[12px]" />
    case 'assignee':
      return <AssigneeCell issue={issue} />
    case 'parent':
      return <ParentCell issue={issue} />
    case 'sprint':
      return <span className={MUTED_CELL}>{issue.sprint ?? '–'}</span>
    case 'storyPoints':
      return (
        <span className={cn(MUTED_CELL, 'tabular-nums')}>
          {formatJiraStoryPoints(issue.storyPoints)}
        </span>
      )
    case 'originalEstimate':
      return (
        <span className={cn(MUTED_CELL, 'tabular-nums')}>
          {formatJiraEstimate(issue.originalEstimateSeconds)}
        </span>
      )
    case 'remainingEstimate':
      return (
        <span className={cn(MUTED_CELL, 'tabular-nums')}>
          {formatJiraEstimate(issue.remainingEstimateSeconds)}
        </span>
      )
    case 'updated':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="block min-w-0 truncate text-[12px] text-muted-foreground">
              {formatUpdatedAt(issue.updatedAt)}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {new Date(issue.updatedAt).toLocaleString()}
          </TooltipContent>
        </Tooltip>
      )
    case 'key':
    case 'title':
      return null
  }
}
