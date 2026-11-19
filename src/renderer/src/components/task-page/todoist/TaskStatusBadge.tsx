import React from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { getJiraStatusTone } from '@/components/task-page/jira/listing/task-page-jira-status-tone'

// Why: Todoist has only open/completed, so reuse Jira's done/new pill tones.
export function TodoistTaskStatusBadge({
  completed,
  className
}: {
  completed: boolean
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none',
        getJiraStatusTone(completed ? 'done' : 'new'),
        className
      )}
    >
      {completed
        ? t('auto.components.TodoistTaskStatusBadge.completed', 'Completed')
        : t('auto.components.TodoistTaskStatusBadge.open', 'Open')}
    </span>
  )
}
