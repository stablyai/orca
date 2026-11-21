import { measureUtf8ByteLength } from '../../../text/utf8-byte-limits'

export const NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD = 32 * 1024
const PASTED_TEXT_LINE_THRESHOLD = 10

/** The composer collapses tall or byte-heavy pastes. A smaller input can supply its own byte limit. */
export function isNativeChatLongPaste(
  text: string,
  threshold = NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD
): boolean {
  return (
    text.length >= threshold ||
    text.split(/\r\n?|\n/, PASTED_TEXT_LINE_THRESHOLD).length >= PASTED_TEXT_LINE_THRESHOLD ||
    measureUtf8ByteLength(text, { stopAfterBytes: threshold - 1 }).exceededLimit
  )
}
