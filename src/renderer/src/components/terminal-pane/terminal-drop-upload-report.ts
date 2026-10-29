import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  describeSharedDropFailureReason,
  describeSharedDropSkipReason
} from '@/lib/drop-skip-reason-copy'

export function reportTerminalDropUploadSkipsAndFailures(
  skipped: { reason: string }[],
  failed: { reason: string }[]
): void {
  if (skipped.length > 0) {
    // Why: symlink rejection is policy, not an error; mixed reasons stay generic.
    const allSymlinks = skipped.every((item) => item.reason === 'symlink')
    toast.message(
      allSymlinks
        ? skipped.length === 1
          ? translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedSymlinks_one',
              'Skipped {{count}} symlink.',
              { count: skipped.length }
            )
          : translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedSymlinks_other',
              'Skipped {{count}} symlinks.',
              { count: skipped.length }
            )
        : skipped.length === 1
          ? translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedItems_one',
              'Skipped {{count}} item.',
              { count: skipped.length }
            )
          : translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedItems_other',
              'Skipped {{count}} items.',
              { count: skipped.length }
            ),
      {
        description: allSymlinks ? undefined : describeSharedDropSkipReason(skipped)
      }
    )
  }
  if (failed.length > 0) {
    toast.error(
      failed.length === 1
        ? translate(
            'auto.components.terminal.pane.terminal.drop.handler.failedUploads_one',
            'Failed to upload {{count}} file.',
            { count: failed.length }
          )
        : translate(
            'auto.components.terminal.pane.terminal.drop.handler.failedUploads_other',
            'Failed to upload {{count}} files.',
            { count: failed.length }
          ),
      { description: describeSharedDropFailureReason(failed) }
    )
  }
}
