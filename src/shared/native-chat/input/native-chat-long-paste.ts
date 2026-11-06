import { measureUtf8ByteLength } from '../../utf8-byte-limits'

export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024

/** A paste this long becomes a "Pasted text" file attachment instead of prompt text. */
export function isNativeChatLongPaste(text: string): boolean {
  return (
    text.length >= NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD ||
    measureUtf8ByteLength(text, { stopAfterBytes: NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD - 1 })
      .exceededLimit
  )
}
