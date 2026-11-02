import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { isTrashDeleteFailure } from '../../../../shared/trash-delete-failure'

type DeleteWithPermanentFallbackParams = {
  name: string
  isRemote: boolean
  isWindows: boolean
  confirm: ConfirmationDialogContextValue
  deletePath: (options?: { permanent?: boolean }) => Promise<void>
  beforePermanentDelete: () => void
}

// Null means cancellation; only a failed local Trash operation permits the permanent retry.
export async function deleteWithPermanentFallback({
  name,
  isRemote,
  isWindows,
  confirm,
  deletePath,
  beforePermanentDelete
}: DeleteWithPermanentFallbackParams): Promise<{ permanent: boolean } | null> {
  try {
    await deletePath()
    return { permanent: false }
  } catch (error) {
    if (isRemote || !isTrashDeleteFailure(error)) {
      throw error
    }
  }
  const confirmed = await confirm({
    title: isWindows
      ? translate(
          'fileExplorer.trashFailed.titleRecycleBin',
          "Couldn't move '{{name}}' to the Recycle Bin. Delete it permanently?",
          { name }
        )
      : translate(
          'fileExplorer.trashFailed.titleTrash',
          "Couldn't move '{{name}}' to the Trash. Delete it permanently?",
          { name }
        ),
    description: translate('fileExplorer.trashFailed.description', 'This cannot be undone.'),
    confirmLabel: translate('fileExplorer.trashFailed.confirm', 'Delete Permanently'),
    confirmVariant: 'destructive',
    cancelVariant: 'ghost',
    surface: 'security'
  })
  if (!confirmed) {
    return null
  }
  beforePermanentDelete()
  await deletePath({ permanent: true })
  return { permanent: true }
}
