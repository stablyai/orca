// @protected-copy
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function deleteWorkspacesCountLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.sidebar.workspaceBatchActionLabels.deleteCount',
    'Delete {{count}} Workspaces',
    { count, defaultValue_one: 'Delete {{count}} Workspace' }
  )
}

function sleepWorkspacesCountLabel(count: number, t: Translate = translate): string {
  return t(
    'auto.components.sidebar.workspaceBatchActionLabels.sleepCount',
    'Sleep {{count}} Workspaces',
    { count, defaultValue_one: 'Sleep {{count}} Workspace' }
  )
}

export function getWorktreeContextMenuBatchLabels(
  args: {
    isMultiContext: boolean
    sleepableCount: number
    deletableCount: number
  },
  t: Translate = translate
): { sleepLabel: string; deleteLabel: string } {
  return {
    sleepLabel:
      args.isMultiContext && args.sleepableCount > 0
        ? sleepWorkspacesCountLabel(args.sleepableCount, t)
        : t('auto.components.sidebar.workspaceBatchActionLabels.sleep', 'Sleep'),
    deleteLabel:
      args.isMultiContext && args.deletableCount > 0
        ? deleteWorkspacesCountLabel(args.deletableCount, t)
        : t('auto.components.sidebar.workspaceBatchActionLabels.deleteSelected', 'Delete Selected')
  }
}
