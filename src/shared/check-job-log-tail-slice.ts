import {
  clampUtf8TextPrefix,
  clampUtf8TextTail,
  getUtf8ByteLength,
  isUtf8ByteLengthWithinLimit
} from './utf8-byte-limits'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from './ansi-escape-sequences'
import { PR_CHECK_LOG_TAIL_BYTES, sanitizeCheckJobLogExcerpt } from './check-job-log-excerpt'

export { PR_CHECK_LOG_TAIL_BYTES } from './check-job-log-excerpt'

export const PR_CHECK_LOG_TAIL_LINES = 200
export const PR_CHECK_LOG_TAIL_RECENT_LINES = 100
export const PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES = 2
export const PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES = 30
export const PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR = '… earlier errors …'

// Install/cache output may bury earlier errors; retain a small error window without downloading the full log.
const ERROR_LINE_PATTERN =
  /(?:##\[error\]|::error::|::error\b|\berror:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError)/i

function matchesErrorMarker(candidate: string): boolean {
  return ERROR_LINE_PATTERN.test(
    stripAnsiEscapeSequences(candidate).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
  )
}

function hasErrorMarker(rawLine: string): boolean {
  if (isUtf8ByteLengthWithinLimit(rawLine, PR_CHECK_LOG_TAIL_BYTES)) {
    return matchesErrorMarker(rawLine)
  }
  const windowBytes = PR_CHECK_LOG_TAIL_BYTES / 2
  return (
    matchesErrorMarker(clampUtf8TextPrefix(rawLine, windowBytes)) ||
    matchesErrorMarker(clampUtf8TextTail(rawLine, windowBytes).text)
  )
}

function applyLogTailByteCap(text: string): string {
  if (isUtf8ByteLengthWithinLimit(text, PR_CHECK_LOG_TAIL_BYTES)) {
    return text
  }
  return clampUtf8TextTail(text, PR_CHECK_LOG_TAIL_BYTES).text
}

function joinLogExcerptWithByteCap(prefixLines: string[], recentLines: string[]): string {
  const prefix = prefixLines.join('\n')
  // Oversized prefixes need no exact byte count, including multibyte text.
  const prefixByteLength =
    prefix.length >= PR_CHECK_LOG_TAIL_BYTES ||
    !isUtf8ByteLengthWithinLimit(prefix, PR_CHECK_LOG_TAIL_BYTES)
      ? PR_CHECK_LOG_TAIL_BYTES
      : getUtf8ByteLength(prefix)
  if (prefixByteLength >= PR_CHECK_LOG_TAIL_BYTES) {
    return clampUtf8TextTail(prefix, PR_CHECK_LOG_TAIL_BYTES).text
  }

  const separator = prefix.length > 0 && recentLines.length > 0 ? '\n' : ''
  const recentBudget = PR_CHECK_LOG_TAIL_BYTES - prefixByteLength - getUtf8ByteLength(separator)
  const recentTail = clampUtf8TextTail(recentLines.join('\n'), recentBudget).text
  return `${prefix}${separator}${recentTail}`
}

function collectEarlierErrorLineIndexes(lines: string[], recentStart: number): number[] {
  const indexes = new Set<number>()
  // Newest-first errors and descending windows add the newest unique indexes first.
  for (let index = recentStart - 1; index >= 0; index -= 1) {
    if (!hasErrorMarker(lines[index] ?? '')) {
      continue
    }
    const contextStart = Math.max(0, index - PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES)
    const contextEnd = Math.min(recentStart - 1, index + PR_CHECK_LOG_TAIL_ERROR_CONTEXT_LINES)
    for (let contextIndex = contextEnd; contextIndex >= contextStart; contextIndex -= 1) {
      indexes.add(contextIndex)
      if (indexes.size === PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES) {
        return [...indexes].sort((left, right) => left - right)
      }
    }
  }
  return [...indexes].sort((left, right) => left - right)
}

function buildCheckLogTail(logText: string): string {
  const lines = logText.split(/\r\n|\r|\n/)
  const recentStart = Math.max(0, lines.length - PR_CHECK_LOG_TAIL_RECENT_LINES)
  const recentLines = lines.slice(recentStart)

  if (recentStart === 0) {
    return applyLogTailByteCap(lines.join('\n'))
  }

  const earlierIndexes = collectEarlierErrorLineIndexes(lines, recentStart)
  if (earlierIndexes.length === 0) {
    return applyLogTailByteCap(lines.slice(-PR_CHECK_LOG_TAIL_LINES).join('\n'))
  }

  const cappedEarlierIndexes = earlierIndexes.slice(-PR_CHECK_LOG_TAIL_MAX_EARLIER_LINES)
  const earlierLines = cappedEarlierIndexes.map((index) => lines[index] ?? '')
  // Retain earlier error context even when the recent tail alone exceeds the byte cap.
  return joinLogExcerptWithByteCap(
    [...earlierLines, PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR],
    recentLines
  )
}

export function sliceCheckLogTail(logText: string): string {
  // Cached excerpts must not pin the downloaded log behind a small V8 slice.
  return sanitizeCheckJobLogExcerpt(buildCheckLogTail(logText))
}
