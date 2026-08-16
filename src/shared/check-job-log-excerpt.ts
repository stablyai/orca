import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { sliceCheckLogTail } from './check-job-log-tail-slice'

// Why: stripping makes several full passes over the input and the slice splits
// every line into an array, so a multi-megabyte job log would stall the
// main-process event loop before it is trimmed to the excerpt budget anyway.
// 512 K chars is far more than any excerpt can keep.
export const MAX_RAW_CHECK_LOG_CHARS = 512 * 1024

/**
 * Cut a raw CI job log down to a bounded tail before any per-character work.
 *
 * Drops the partial first line so an escape sequence cut in half cannot survive
 * stripping as visible garbage. CR counts as a boundary: the redraw-only output
 * this excerpt exists to tame carries no LF at all.
 */
export function boundRawCheckLogTail(log: string): string {
  if (log.length <= MAX_RAW_CHECK_LOG_CHARS) {
    return log
  }
  const tail = log.slice(log.length - MAX_RAW_CHECK_LOG_CHARS)
  const firstLineBreak = tail.search(/[\r\n]/)
  return firstLineBreak === -1 ? tail : tail.slice(firstLineBreak + 1)
}

/**
 * Turn a raw CI job log into the bounded, readable excerpt Orca stores on a
 * check job.
 *
 * The excerpt is untrusted web content: a PR author controls what CI prints, it
 * is rendered verbatim in a `<pre>` and embedded in the fix-checks agent prompt.
 * Escape sequences left in would show as literal garbage, eat the byte budget
 * that should hold real failure output, and hide error markers from the
 * earlier-error scan.
 */
export function toReadableCheckLogExcerpt(log: string): string {
  if (!log) {
    return ''
  }
  const readable = stripAnsiEscapeSequences(boundRawCheckLogTail(log))
    // Why: progress output redraws with bare CR, which would otherwise make the
    // whole job log a single line and defeat the line-based tail.
    .replace(/\r\n?/g, '\n')
  return sliceCheckLogTail(readable).trim()
}
