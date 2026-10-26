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
        ? translate('terminalDrop.skippedSymlinks', 'Skipped {{count}} symlinks.', {
            count: skipped.length,
            defaultValue_one: 'Skipped {{count}} symlink.'
          })
        : translate('terminalDrop.skippedItems', 'Skipped {{count}} items.', {
            count: skipped.length,
            defaultValue_one: 'Skipped {{count}} item.'
          }),
      {
        description: allSymlinks ? undefined : describeSharedDropSkipReason(skipped)
      }
    )
  }
  if (failed.length > 0) {
    toast.error(
      translate('terminalDrop.failedUploads', 'Failed to upload {{count}} files.', {
        count: failed.length,
        defaultValue_one: 'Failed to upload {{count}} file.'
      }),
      { description: describeSharedDropFailureReason(failed) }
    )
  }
}
