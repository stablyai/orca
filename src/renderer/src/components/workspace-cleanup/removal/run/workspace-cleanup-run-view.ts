import { useAppStore } from '@/store'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceCleanupRunCounts } from './workspace-cleanup-run-store'

export const WORKSPACE_CLEANUP_RUN_VIEW_MODAL_DATA = {
  key: 'workspaceCleanupView',
  value: 'run'
} as const

/** Reopens the cleanup dialog on its Deleting or Done step. */
export function openWorkspaceCleanupRunView(): void {
  useAppStore.getState().openModal('workspace-cleanup', {
    [WORKSPACE_CLEANUP_RUN_VIEW_MODAL_DATA.key]: WORKSPACE_CLEANUP_RUN_VIEW_MODAL_DATA.value
  })
}

export function getWorkspaceCleanupRunFinishedTitle(
  t: Translate,
  { deleted, total }: WorkspaceCleanupRunCounts
): string {
  return total === 1
    ? t(
        'components.workspace.cleanup.done.singleTitle',
        'Deleted {{deleted}} of {{total}} workspace',
        {
          deleted,
          total
        }
      )
    : t('components.workspace.cleanup.done.title', 'Deleted {{deleted}} of {{total}} workspaces', {
        deleted,
        total
      })
}
