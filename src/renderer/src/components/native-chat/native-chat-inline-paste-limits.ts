import { translate } from '@/i18n/i18n'
import { isUtf8ByteLengthWithinLimit } from '../../../../shared/utf8-byte-limits'

/** Chromium lays out one wrapped line in superlinear time (about 0.7 s at 31 KB, 23 s at 1 MiB); many short lines stay cheap. */
export const NATIVE_CHAT_INLINE_LINE_MAX_CHARS = 16 * 1024
/** A message over 256 KB cannot be sent, so a larger inline paste could never be used. */
export const NATIVE_CHAT_INLINE_PASTE_MAX_BYTES = 256 * 1024

export type NativeChatInlinePasteProblem = 'too-large' | 'line-too-long'

const LINE_BREAK = /\r\n|\r|\n/g

/** What stops `text` from going into the editor without a stall; the draft around it is not counted. */
export function nativeChatInlinePasteProblem(text: string): NativeChatInlinePasteProblem | null {
  if (!isUtf8ByteLengthWithinLimit(text, NATIVE_CHAT_INLINE_PASTE_MAX_BYTES)) {
    return 'too-large'
  }
  let longest = 0
  let lineStart = 0
  LINE_BREAK.lastIndex = 0
  for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) {
    longest = Math.max(longest, match.index - lineStart)
    lineStart = match.index + match[0].length
  }
  longest = Math.max(longest, text.length - lineStart)
  return longest > NATIVE_CHAT_INLINE_LINE_MAX_CHARS ? 'line-too-long' : null
}

export function nativeChatInlinePasteNotice(problem: NativeChatInlinePasteProblem): string {
  return problem === 'too-large'
    ? translate(
        'components.native-chat.composer.inlinePasteTooLarge',
        'This paste is too large to edit inline. Paste a smaller section.'
      )
    : translate(
        'components.native-chat.composer.inlinePasteLineTooLong',
        'This paste has a line that is too long to edit. Add line breaks, or paste a smaller section.'
      )
}
