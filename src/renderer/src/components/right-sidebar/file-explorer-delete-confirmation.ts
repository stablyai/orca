import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'

export function fileExplorerBatchDeleteConfirmation({
  count,
  hasLocalDelete,
  isWindows
}: {
  count: number
  hasLocalDelete: boolean
  isWindows: boolean
}): ConfirmationDialogOptions {
  const trashName = isWindows
    ? translate('fileExplorer.recycleBin', 'Recycle Bin')
    : translate('fileExplorer.trash', 'Trash')
  return {
    title: hasLocalDelete
      ? translate(
          'auto.components.right.sidebar.useFileDeletion.77fdc36183',
          'Delete {{count}} items?',
          { count }
        )
      : translate(
          'auto.components.right.sidebar.useFileDeletion.af1270b90d',
          'Permanently delete {{count}} items?',
          { count }
        ),
    description: hasLocalDelete
      ? translate(
          'auto.components.right.sidebar.useFileDeletion.fca915a67a',
          'Remote items are permanently deleted and cannot be undone. Local items move to the {{value0}}.',
          { value0: trashName }
        )
      : translate(
          'auto.components.right.sidebar.useFileDeletion.dd029aa5cd',
          'This permanently deletes the selected items and any directory contents on the remote host. This cannot be undone.'
        ),
    confirmLabel: translate('auto.components.right.sidebar.useFileDeletion.92276aceb7', 'Delete'),
    confirmVariant: 'destructive'
  }
}
