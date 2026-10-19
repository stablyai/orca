import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'
import { ownRetainedString } from './own-retained-string'
import { clampUtf8TextTail, isUtf8ByteLengthWithinLimit } from './utf8-byte-limits'

export const PR_CHECK_LOG_TAIL_BYTES = 16 * 1024

export function sanitizeCheckJobLogExcerpt(value: string): string {
  const bounded = isUtf8ByteLengthWithinLimit(value, PR_CHECK_LOG_TAIL_BYTES)
    ? value
    : clampUtf8TextTail(value, PR_CHECK_LOG_TAIL_BYTES).text
  return ownRetainedString(
    stripAnsiEscapeSequences(bounded)
      .replace(/\r\n?/g, '\n')
      .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
  )
}
