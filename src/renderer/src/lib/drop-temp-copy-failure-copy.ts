import { translate } from '@/i18n/i18n'
import type { NativeFileDropCopyFailureReason } from '../../../shared/native-file-drop'
import { describeDropSkipReason } from './drop-skip-reason-copy'

/** User-facing copy for why main could not copy dropped files; generic when they had no shared reason. */
export function describeDropTempCopyFailure(
  reason: NativeFileDropCopyFailureReason | undefined
): string {
  switch (reason) {
    case 'missing':
    case 'permission-denied':
      return describeDropSkipReason(reason) ?? genericFailure()
    case 'changed':
      return translate(
        'auto.lib.dropTempCopyFailure.changed',
        'The file changed while Orca was copying it. Try the drop again.'
      )
    case 'out-of-space':
      return translate(
        'auto.lib.dropTempCopyFailure.outOfSpace',
        'Not enough disk space to copy the dropped files.'
      )
    case 'storage-unavailable':
      return translate(
        'auto.lib.dropTempCopyFailure.storageUnavailable',
        "Orca couldn't create storage for dropped files."
      )
    case 'storage-not-private':
      return translate(
        'auto.lib.dropTempCopyFailure.storageNotPrivate',
        "Orca's storage for dropped files can be read by other users, so nothing was copied."
      )
    case 'timed-out':
      return translate(
        'auto.lib.dropTempCopyFailure.timedOut',
        'Copying took too long. Try the drop again.'
      )
    case 'busy':
      return translate(
        'auto.lib.dropTempCopyFailure.busy',
        'Too many drops are still being copied. Wait a moment, then try again.'
      )
    case 'too-large':
      return translate(
        'auto.lib.dropTempCopyFailure.tooLarge',
        "Too large to copy, so Orca couldn't hand it to the agent."
      )
    case 'storage-full':
      return translate(
        'auto.lib.dropTempCopyFailure.storageFull',
        "Orca's storage for dropped files is full, so Orca couldn't hand it to the agent."
      )
    case 'copy-failed':
    case undefined:
      return genericFailure()
  }
}

function genericFailure(): string {
  return translate('auto.lib.dropTempCopyFailure.generic', 'Try the drop again.')
}
