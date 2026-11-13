import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** Translate only shipped status labels; configured names remain literal. */
export function translateWorkspaceBoardStatusLabel(status: { id: string; label: string }): string {
  switch (status.id) {
    case 'todo':
      return !status.label.trim() || status.label === 'Todo'
        ? translate('auto.components.sidebar.workspaceBoardStatus.todo', 'Todo')
        : status.label
    case 'in-progress':
      return !status.label.trim() || status.label === 'In progress'
        ? translate('auto.components.sidebar.workspaceBoardStatus.inProgress', 'In progress')
        : status.label
    case 'in-review':
      return !status.label.trim() || status.label === 'In review'
        ? translate('auto.components.sidebar.workspaceBoardStatus.inReview', 'In review')
        : status.label
    case 'completed':
      return !status.label.trim() || status.label === 'Done'
        ? translate('auto.components.sidebar.workspaceBoardStatus.done', 'Done')
        : status.label
    default:
      return translateNumberedStatusLabel(status.label)
  }
}

// Why: new statuses ship as "Status N" (workspace-statuses.ts), so that default localizes too.
function translateNumberedStatusLabel(label: string, t: Translate = translate): string {
  const numberedStatus = /^Status (\d+)$/.exec(label)
  return numberedStatus
    ? t('auto.components.sidebar.workspaceBoardStatus.numbered', 'Status {{number}}', {
        number: numberedStatus[1]
      })
    : label
}

/** Localize built-in/common workflow names without changing provider-defined custom states. */
export function translateDefaultWorkflowStateLabel(
  label: string,
  t: Translate = translate
): string {
  switch (label) {
    case 'Todo':
    case 'To do':
      return t('auto.components.sidebar.workspaceBoardStatus.todo', 'Todo')
    case 'In progress':
    case 'In Progress':
      return t('auto.components.sidebar.workspaceBoardStatus.inProgress', 'In progress')
    case 'In review':
    case 'In Review':
      return t('auto.components.sidebar.workspaceBoardStatus.inReview', 'In review')
    case 'Done':
    case 'Completed':
      return t('auto.components.sidebar.workspaceBoardStatus.done', 'Done')
    default:
      return translateNumberedStatusLabel(label, t)
  }
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
