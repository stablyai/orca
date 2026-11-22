import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** Translate only shipped status labels; configured names remain literal. */
export function translateWorkspaceBoardStatusLabel(
  status: { id: string; label: string },
  t: Translate = translate
): string {
  switch (status.id) {
    case 'todo':
      return !status.label.trim() || status.label === 'Todo'
        ? t('auto.components.sidebar.workspaceBoardStatus.todo', 'Todo')
        : status.label
    case 'in-progress':
      return !status.label.trim() || status.label === 'In progress'
        ? t('auto.components.sidebar.workspaceBoardStatus.inProgress', 'In progress')
        : status.label
    case 'in-review':
      return !status.label.trim() || status.label === 'In review'
        ? t('auto.components.sidebar.workspaceBoardStatus.inReview', 'In review')
        : status.label
    case 'completed':
      return !status.label.trim() || status.label === 'Done'
        ? t('auto.components.sidebar.workspaceBoardStatus.done', 'Done')
        : status.label
    default:
      return status.label
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
