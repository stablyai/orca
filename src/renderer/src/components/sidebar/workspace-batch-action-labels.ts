import { translate } from '@/i18n/i18n'

export function deleteWorkspacesCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.sidebar.workspaceBatchActionLabels.deleteCount_one',
        'Delete 1 Workspace',
        { count }
      )
    : translate(
        'auto.components.sidebar.workspaceBatchActionLabels.deleteCount_other',
        'Delete {{count}} Workspaces',
        { count }
      )
}

function sleepWorkspacesCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.sidebar.workspaceBatchActionLabels.sleepCount_one',
        'Sleep 1 Workspace',
        { count }
      )
    : translate(
        'auto.components.sidebar.workspaceBatchActionLabels.sleepCount_other',
        'Sleep {{count}} Workspaces',
        { count }
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
