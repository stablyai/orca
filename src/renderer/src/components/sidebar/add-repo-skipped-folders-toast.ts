import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function showSkippedBatchFoldersToast(): void {
  toast.info(
    translate(
      'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFolders',
      'Some folders were skipped'
    ),
    {
      description: translate(
        'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFoldersDescription',
        'Add skipped folders individually to review or confirm them.'
      )
    }
  )
}
