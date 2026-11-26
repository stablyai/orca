import { measureUtf8ByteLength } from '../../../text/utf8-byte-limits'

export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024

/** A paste this long becomes a "Pasted text" file attachment instead of prompt text; a box whose
 *  text limit is lower passes that limit. */
export function isNativeChatLongPaste(
  text: string,
  threshold = NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD
): boolean {
  return (
    text.length >= threshold ||
    measureUtf8ByteLength(text, { stopAfterBytes: threshold - 1 }).exceededLimit
  )
}
