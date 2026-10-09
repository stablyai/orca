import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { describeDropSkipReason } from '@/lib/drop-skip-reason-copy'
import { hasUploadLeftovers } from '../../../../shared/ssh-import-cancel-reason'

/**
 * A cancel is the user's own decision, not a failure to report back — unless it left files on
 * the host. A scoped panel closes unseen once the user switches away, so this is the only notice.
 */
export function failuresToReport<T extends { reason: string }>(
  failed: T[],
  isCancelled: (item: T) => boolean
): T[] {
  return failed.filter((item) => !isCancelled(item) || hasUploadLeftovers(item.reason))
}

export function reportTerminalDropUploadSkipsAndFailures(
  skipped: { reason: string }[],
  failed: { reason: string }[],
  /** Names the destination workspace when the user has switched away from it. */
  workspaceDescription?: string
): void {
  if (skipped.length > 0) {
    // Why: symlink rejection is policy, not an error; mixed reasons stay generic.
    const allSymlinks = skipped.every((item) => item.reason === 'symlink')
    const noun = skipped.length === 1 ? 'item' : 'items'
    const commonReason = sharedReason(skipped)
    toast.message(
      allSymlinks
        ? translate(
            'auto.components.terminal.pane.terminal.drop.handler.53f015fd85',
            'Skipped {{value0}} symlink{{value1}}.',
            { value0: skipped.length, value1: skipped.length === 1 ? '' : 's' }
          )
        : translate(
            'auto.components.terminal.pane.terminal.drop.handler.b4cf68e889',
            'Skipped {{value0}} {{value1}}.',
            { value0: skipped.length, value1: noun }
          ),
      {
        description:
          commonReason && commonReason !== 'symlink'
            ? describeDropSkipReason(commonReason)
            : undefined
      }
    )
  }
  if (failed.length > 0) {
    const noun = failed.length === 1 ? 'file' : 'files'
    // Why: main words the leftover itself and the row may already be gone, so show it as-is.
    // Joined inline: toast descriptions collapse newlines.
    const leftovers = failed.map((item) => item.reason).filter(hasUploadLeftovers)
    const leftoverNote =
      leftovers.length > 1 ? `${leftovers[0]} (+${leftovers.length - 1} more)` : leftovers[0]
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.drop.handler.1e072f611e',
        'Failed to upload {{value0}} {{value1}}.',
        { value0: failed.length, value1: noun }
      ),
      { description: [workspaceDescription, leftoverNote].filter(Boolean).join('. ') || undefined }
    )
  }
}

function sharedReason(items: { reason: string }[]): string | undefined {
  const first = items[0]?.reason
  return first !== undefined && items.every((item) => item.reason === first) ? first : undefined
}
