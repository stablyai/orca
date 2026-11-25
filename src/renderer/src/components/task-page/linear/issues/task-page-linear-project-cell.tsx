import React from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { LinearIssueProjectPopover } from '@/components/task-page/linear/issue-workspace/linear-issue-project-selector'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'

export function LinearProjectCell({
  issue,
  className,
  sourceContext
}: {
  issue: LinearIssue
  className?: string
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  const t = useTranslate()
  const projectName =
    issue.project?.name ?? t('auto.components.TaskPage.linearNoProject', 'No project')
  return (
    // Why: popover clicks bubble through the portal to the row, which would open the issue.
    <span className="flex min-w-0 max-w-full" onClick={(event) => event.stopPropagation()}>
      <LinearIssueProjectPopover issue={issue} sourceContext={sourceContext}>
        <button
          type="button"
          className={cn(
            'group/project inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[12px] text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
          aria-label={t(
            'auto.components.TaskPage.linearChangeProject',
            'Change project for {{value0}} from {{value1}}',
            { value0: issue.identifier, value1: projectName }
          )}
        >
          {issue.project ? (
            <span
              className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
              style={issue.project.color ? { backgroundColor: issue.project.color } : undefined}
            />
          ) : null}
          <span className={cn('truncate', !issue.project && 'opacity-60')}>{projectName}</span>
          <ChevronDown className="size-3 shrink-0 opacity-0 group-hover/project:opacity-55 group-focus-visible/project:opacity-55" />
        </button>
      </LinearIssueProjectPopover>
    </span>
  )
}
