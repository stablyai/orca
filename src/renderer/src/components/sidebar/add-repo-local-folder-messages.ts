import { translate } from '@/i18n/i18n'

export function addRepoRemoteHostPathRequiredMessage(): string {
  return translate(
    'auto.components.sidebar.useAddRepoLocalFolderFlow.7ab10e4974',
    'Use a host path to add projects from a remote host.'
  )
}

export function addRepoSkippedBatchFoldersToast(): {
  title: string
  description: string
} {
  return {
    title: translate(
      'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFolders',
      'Some folders were skipped'
    ),
    description: translate(
      'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFoldersDescription',
      'Add skipped folders individually to review or confirm them.'
    )
  }
}
