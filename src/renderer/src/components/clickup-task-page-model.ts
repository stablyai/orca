import type { ClickUpTask, ClickUpTaskFilter } from '../../../shared/clickup-types'
import { translate } from '@/i18n/i18n'

export function getClickUpFilters(): { value: ClickUpTaskFilter; label: string }[] {
  return [
    {
      value: 'assigned',
      label: translate('auto.components.clickup.page.filterAssigned', 'Assigned to me')
    },
    { value: 'open', label: translate('auto.components.clickup.page.filterOpen', 'Open') },
    {
      value: 'created',
      label: translate('auto.components.clickup.page.filterCreated', 'Created by me')
    },
    {
      value: 'completed',
      label: translate('auto.components.clickup.page.filterCompleted', 'Completed')
    },
    { value: 'all', label: translate('auto.components.clickup.page.filterAll', 'All') }
  ]
}

export function clickUpTaskReference(task: ClickUpTask): string {
  return task.customId ?? task.id
}

export function linkedClickUpTaskContext(task: ClickUpTask): string {
  return [
    `ClickUp task: ${clickUpTaskReference(task)} — ${task.name}`,
    `Status: ${task.status.name}`,
    `List: ${[task.workspaceName, task.space?.name, task.folder?.name, task.list.name]
      .filter(Boolean)
      .join(' / ')}`,
    task.url,
    task.description ? `\nDescription:\n${task.description}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
