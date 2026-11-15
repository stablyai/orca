import { useAppStore } from '@/store'

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
