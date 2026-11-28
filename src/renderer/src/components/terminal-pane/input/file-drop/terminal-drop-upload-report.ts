import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  describeSharedDropFailureReason,
  describeSharedDropSkipReason
} from '@/lib/files/drop/drop-skip-reason-copy'

export function reportTerminalDropUploadSkipsAndFailures(
  skipped: { reason: string }[],
  failed: { reason: string }[]
): void {
  if (skipped.length > 0) {
    // Why: symlink rejection is policy, not an error; mixed reasons stay generic.
    const allSymlinks = skipped.every((item) => item.reason === 'symlink')
    toast.message(
      allSymlinks
        ? translate(
            'auto.components.terminal.pane.terminal.drop.handler.skippedSymlinks',
            'Skipped {{count}} symlinks.',
            { count: skipped.length, defaultValue_one: 'Skipped {{count}} symlink.' }
          )
        : translate(
            'auto.components.terminal.pane.terminal.drop.handler.skippedItems',
            'Skipped {{count}} items.',
            { count: skipped.length, defaultValue_one: 'Skipped {{count}} item.' }
          ),
      {
        description: allSymlinks ? undefined : describeSharedDropSkipReason(skipped)
      }
    )
  }
  if (failed.length > 0) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.failedUploads',
        'Failed to upload {{count}} files.',
        { count: failed.length, defaultValue_one: 'Failed to upload {{count}} file.' }
      ),
      { description: describeSharedDropFailureReason(failed) }
    )
  }
}

export function reportUnpastedTerminalDropUploads(
  paths: readonly string[],
  paneStillOpen: boolean
): void {
  const pathList = paths.join('\n')
  const toastId = toast.message(
    translate(
      'terminal.fileDrop.uploadedWithoutPaste',
      "Upload finished, but the paths couldn't be pasted into the terminal."
    ),
    {
      description: pathList,
      // Large drops list up to 256 paths; keep the close button on screen.
      classNames: { description: 'max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words' },
      // Parked or reconnected panes may be revisited later; a closed pane was likely closed on purpose.
      duration: paneStillOpen ? Infinity : undefined,
      action: {
        label: translate('terminal.fileDrop.copyUploadedPaths', 'Copy paths'),
        onClick: (event) => {
          // Keep the paths visible until the copy succeeds.
          event.preventDefault()
          window.api.ui.writeClipboardText(pathList).then(
            () => toast.dismiss(toastId),
            () =>
              toast.error(
                translate(
                  'terminal.fileDrop.copyUploadedPathsFailed',
                  'Could not copy uploaded paths.'
                )
              )
          )
        }
      }
    }
  )
}
