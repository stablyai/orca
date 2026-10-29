import { translate } from '@/i18n/i18n'

export function deleteWorkspacesCountLabel(count: number): string {
  return translate(
    'auto.components.sidebar.workspaceBatchActionLabels.deleteCount',
    'Delete {{count}} Workspaces',
    { count, defaultValue_one: 'Delete {{count}} Workspace' }
  )
}

function sleepWorkspacesCountLabel(count: number): string {
  return translate(
    'auto.components.sidebar.workspaceBatchActionLabels.sleepCount',
    'Sleep {{count}} Workspaces',
    { count, defaultValue_one: 'Sleep {{count}} Workspace' }
  )
}

export function getWorktreeContextMenuBatchLabels(args: {
  isMultiContext: boolean
  sleepableCount: number
  deletableCount: number
}): { sleepLabel: string; deleteLabel: string } {
  return {
    sleepLabel:
      args.isMultiContext && args.sleepableCount > 0
        ? sleepWorkspacesCountLabel(args.sleepableCount)
        : translate('auto.components.sidebar.workspaceBatchActionLabels.sleep', 'Sleep'),
    deleteLabel:
      args.isMultiContext && args.deletableCount > 0
        ? deleteWorkspacesCountLabel(args.deletableCount)
        : translate(
            'auto.components.sidebar.workspaceBatchActionLabels.deleteSelected',
            'Delete Selected'
          )
  }
}
