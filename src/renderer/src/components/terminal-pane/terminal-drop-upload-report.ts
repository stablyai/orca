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
    const noun = skipped.length === 1 ? 'item' : 'items'
    toast.message(
      symlinkCount === skipped.length
        ? translate(
            'auto.components.terminal.pane.terminal.drop.handler.53f015fd85',
            'Skipped {{value0}} symlink{{value1}}.',
            { value0: skipped.length, value1: skipped.length === 1 ? '' : 's' }
          )
        : translate(
            'auto.components.terminal.pane.terminal.drop.handler.b4cf68e889',
            'Skipped {{value0}} {{value1}}.',
            { value0: skipped.length, value1: noun }
          )
    )
  }
  if (failed.length > 0) {
    const noun = failed.length === 1 ? 'file' : 'files'
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.1e072f611e',
        'Failed to upload {{value0}} {{value1}}.',
        { value0: failed.length, value1: noun }
      )
    )
  }
}
