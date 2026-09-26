import { toast } from 'sonner'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'

/** A capped git status lists only a prefix of the changes, so a whole-repo discard is refused. */
export function showRepoDiscardBlockedToast(repoName: string): void {
  toast.error(
    translate(
      'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoBlockedByLimit',
      'Too many changes in {{value0}} to discard all at once',
      { value0: repoName }
    ),
    {
      description: translate(
        'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoBlockedByLimitCopy',
        'Git status was cut short, so only part of the change list is known. Discard from the repo itself.'
      )
    }
  )
}

export function showRepoDiscardAbortedToast(repoName: string, error: unknown): void {
  toast.error(
    translate(
      'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoAborted',
      'Discard all failed in {{value0}}: unable to unstage files before discard',
      { value0: repoName }
    ),
    { description: readIpcErrorMessage(error) }
  )
}

export function showRepoDiscardFailedToast(
  repoName: string,
  errors: readonly unknown[],
  failedPaths: readonly string[]
): void {
  toast.error(
    translate(
      'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoFailed',
      'Failed to discard {{value0}} of the changes in {{value1}}',
      { value0: failedPaths.length, value1: repoName }
    ),
    { description: describeDiscardFailures(errors, failedPaths) }
  )
}

/** First error plus a short sample of failed paths, so a bulk failure never produces a huge toast. */
function describeDiscardFailures(
  errors: readonly unknown[],
  failedPaths: readonly string[]
): string {
  const sample = failedPaths.slice(0, 3).join(', ')
  const more =
    failedPaths.length > 3
      ? translate(
          'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardRepoFailedMore',
          ', +{{value0}} more',
          { value0: failedPaths.length - 3 }
        )
      : ''
  const firstMessage = readIpcErrorMessage(errors[0])
  return firstMessage ? `${firstMessage} (${sample}${more})` : `${sample}${more}`
}
