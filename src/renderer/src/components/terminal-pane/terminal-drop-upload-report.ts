import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function reportTerminalDropUploadSkipsAndFailures(
  skipped: { reason: string }[],
  failed: { reason: string }[]
): void {
  if (skipped.length > 0) {
    // Why: symlink rejection is policy, not error. Mixed skips collapse to one
    // count so the terminal drop UI stays readable for multi-file drops.
    const symlinkCount = skipped.filter((s) => s.reason === 'symlink').length
    const skippedCount = skipped.length
    toast.message(
      symlinkCount === skipped.length
        ? // Why: each complete count variant is independently translatable;
          // noun and suffix fragments cannot represent non-English grammar.
          skippedCount === 1
          ? translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedOneSymlink',
              'Skipped {{count}} symlink.',
              { count: skippedCount }
            )
          : translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedManySymlinks',
              'Skipped {{count}} symlinks.',
              { count: skippedCount }
            )
        : skippedCount === 1
          ? translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedOneItem',
              'Skipped {{count}} item.',
              { count: skippedCount }
            )
          : translate(
              'auto.components.terminal.pane.terminal.drop.handler.skippedManyItems',
              'Skipped {{count}} items.',
              { count: skippedCount }
            )
    )
  }
  if (failed.length > 0) {
    // Why: keep the complete file-count phrase in the catalog rather than
    // interpolating an English noun into an otherwise translated sentence.
    const failedCount = failed.length
    toast.error(
      failedCount === 1
        ? translate(
            'auto.components.terminal.pane.terminal.drop.handler.failedToUploadOneFile',
            'Failed to upload {{count}} file.',
            { count: failedCount }
          )
        : translate(
            'auto.components.terminal.pane.terminal.drop.handler.failedToUploadManyFiles',
            'Failed to upload {{count}} files.',
            { count: failedCount }
          )
    )
  }
}
