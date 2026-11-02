import { isClipboardTextWriteTooLargeError } from '../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'

/** Show only known safe reasons; native/platform details in unknown write failures remain in main-process logs. */
export function describeClipboardWriteFailure(error: unknown): string | undefined {
  if (isClipboardTextWriteTooLargeError(error)) {
    return translate('auto.lib.clipboardWriteFailure.tooLarge', 'The text is too large to copy.')
  }
  return undefined
}
