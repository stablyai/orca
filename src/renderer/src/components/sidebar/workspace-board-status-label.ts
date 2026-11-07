import { translate } from '@/i18n/i18n'

/** Map default board status ids / English labels to the active UI locale. */
export function translateWorkspaceBoardStatusLabel(status: { id: string; label: string }): string {
  // Why: a renamed built-in status keeps the user's label; only the shipped English defaults translate.
  if (status.label.trim() !== '') {
    return translateDefaultWorkflowStateLabel(status.label)
  }
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
      return status.label
  }
}

/** Localize built-in/common workflow names without changing provider-defined custom states. */
export function translateDefaultWorkflowStateLabel(label: string): string {
  switch (label) {
    case 'Todo':
    case 'To do':
      return translate('auto.components.sidebar.workspaceBoardStatus.todo', 'Todo')
    case 'In progress':
    case 'In Progress':
      return translate('auto.components.sidebar.workspaceBoardStatus.inProgress', 'In progress')
    case 'In review':
    case 'In Review':
      return translate('auto.components.sidebar.workspaceBoardStatus.inReview', 'In review')
    case 'Done':
    case 'Completed':
      return translate('auto.components.sidebar.workspaceBoardStatus.done', 'Done')
    default:
      break
  }
  const numberedStatus = /^Status (\d+)$/.exec(label)
  return numberedStatus
    ? translate('auto.components.sidebar.workspaceBoardStatus.numbered', 'Status {{number}}', {
        number: numberedStatus[1]
      })
    : label
}

/** Status lane headers arrive in English from the shared emitter; shipped defaults localize here. */
export function translateWorkspaceStatusHeaderLabel(
  statusId: string | null,
  label: string
): string {
  return statusId ? translateWorkspaceBoardStatusLabel({ id: statusId, label }) : label
}

export function newWorkspaceInStatusTooltip(statusLabel: string): string {
  return translate(
    'auto.components.sidebar.workspaceKanbanStatusLane.newWorkspaceInStatus',
    'New workspace in {{status}}',
    { status: statusLabel }
  )
}
