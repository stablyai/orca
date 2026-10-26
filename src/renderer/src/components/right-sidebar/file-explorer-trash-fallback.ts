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

// Trash can be unavailable (e.g. Recycle Bin disabled for the drive); let the user opt into permanent delete.
// Returns null when the user declines; otherwise whether the delete bypassed Trash.
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
    confirmVariant: 'destructive'
  })
  if (!confirmed) {
    return null
  }
  beforePermanentDelete()
  await deletePath({ permanent: true })
  return { permanent: true }
}
