import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { describeDropSkipReason } from '@/lib/drop-skip-reason-copy'

export function reportTerminalDropUploadSkipsAndFailures(
  skipped: { reason: string }[],
  failed: { reason: string }[]
): void {
  if (skipped.length > 0) {
    // Why: symlink rejection is policy, not an error; mixed reasons stay generic.
    const allSymlinks = skipped.every((item) => item.reason === 'symlink')
    const commonReason = sharedReason(skipped)
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
        description:
          commonReason && commonReason !== 'symlink'
            ? describeDropSkipReason(commonReason)
            : undefined
      }
    )
  }
  if (failed.length > 0) {
    toast.error(
      translate('terminalDrop.failedUploads', 'Failed to upload {{count}} files.', {
        count: failed.length,
        defaultValue_one: 'Failed to upload {{count}} file.'
      })
    )
  }
}

function sharedReason(items: { reason: string }[]): string | undefined {
  const first = items[0]?.reason
  return first !== undefined && items.every((item) => item.reason === first) ? first : undefined
}
