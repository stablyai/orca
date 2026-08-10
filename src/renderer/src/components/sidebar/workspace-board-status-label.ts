import { translate } from '@/i18n/i18n'

/** Map default board status ids / English labels to the active UI locale. */
export function translateWorkspaceBoardStatusLabel(status: { id: string; label: string }): string {
  switch (status.id) {
    case 'todo':
      return translate('auto.components.sidebar.workspaceBoardStatus.todo', 'Todo')
    case 'in-progress':
      return translate('auto.components.sidebar.workspaceBoardStatus.inProgress', 'In progress')
    case 'in-review':
      return translate('auto.components.sidebar.workspaceBoardStatus.inReview', 'In review')
    case 'completed':
      return translate('auto.components.sidebar.workspaceBoardStatus.done', 'Done')
    default:
      break
  }
  switch (status.label) {
    case 'Todo':
      return translate('auto.components.sidebar.workspaceBoardStatus.todo', 'Todo')
    case 'In progress':
      return translate('auto.components.sidebar.workspaceBoardStatus.inProgress', 'In progress')
    case 'In review':
      return translate('auto.components.sidebar.workspaceBoardStatus.inReview', 'In review')
    case 'Done':
    case 'Completed':
      return translate('auto.components.sidebar.workspaceBoardStatus.done', 'Done')
    default:
      return status.label
  }
}

export function newWorkspaceInStatusTooltip(statusLabel: string): string {
  return translate(
    'auto.components.sidebar.workspaceKanbanStatusLane.newWorkspaceInStatus',
    'New workspace in {{status}}',
    { status: statusLabel }
  )
}
