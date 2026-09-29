import { isClipboardTextWriteTooLargeError } from '../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'

/**
 * Closed set of clipboard-write reasons safe to show. A rejected write can carry native
 * clipboard or platform detail, so an unrecognized reason gets no description at all and
 * the raw error stays in the main-process log.
 */
export function describeClipboardWriteFailure(error: unknown): string | undefined {
  if (isClipboardTextWriteTooLargeError(error)) {
    return translate('auto.lib.clipboardWriteFailure.tooLarge', 'The text is too large to copy.')
  }
  return undefined
}
