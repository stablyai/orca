import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { sliceCheckLogTail } from './check-job-log-tail-slice'
import type { GitLabJobTraceResult } from './gitlab-types'

// GitLab wraps collapsible sections in `section_start:<unix>:<name>\r<CSI>0K<visible header>`;
// strip only through the CR so the human-readable header on the same line survives.
const SECTION_MARKER_PREFIX_PATTERN = /^section_(?:start|end):\d+:[^\r\n]*?\r/gm
// Sections without a visible header leave a marker-only line; drop it whole.
const SECTION_MARKER_LINE_PATTERN = /^section_(?:start|end):\d+:[^\r\n]*\n?/gm

// Why: stripping makes several full passes over the input, so a multi-megabyte CI log
// would stall the main-process event loop before the tail is trimmed to 16 KB anyway.
// 512 K chars is far more than the excerpt can keep, even with markup removed.
const MAX_RAW_TRACE_CHARS = 512 * 1024

function rawTraceTail(trace: string): string {
  if (trace.length <= MAX_RAW_TRACE_CHARS) {
    return trace
  }
  const tail = trace.slice(trace.length - MAX_RAW_TRACE_CHARS)
  // Drop the partial first line so a marker or escape cut in half cannot survive stripping.
  const firstLineBreak = tail.indexOf('\n')
  return firstLineBreak === -1 ? tail : tail.slice(firstLineBreak + 1)
}

/**
 * Turn a raw `glab api .../jobs/:id/trace` body into a bounded, readable excerpt.
 *
 * Bounding is not cosmetic: the runtime RPC transports drop frames over 1 MB
 * (`MAX_WS_MESSAGE_BYTES` / `MAX_RELAY_MESSAGE_BYTES`), so a multi-megabyte CI
 * log must be cut before it crosses the wire, not after.
 */
export function gitLabJobTraceToLogExcerpt(trace: string): string {
  if (!trace) {
    return ''
  }
  // Order matters: ANSI first so the erase-to-EOL sequence between the marker's CR
  // and its header text is gone, CR normalisation last so the marker patterns can
  // still see the CR that separates a marker from its visible header.
  const readable = stripAnsiEscapeSequences(rawTraceTail(trace))
    .replace(SECTION_MARKER_PREFIX_PATTERN, '')
    .replace(SECTION_MARKER_LINE_PATTERN, '')
    // Why: progress output redraws with bare CR, which would otherwise make the
    // whole job log a single line and defeat the line-based tail.
    .replace(/\r\n?/g, '\n')
  return sliceCheckLogTail(readable).trim()
}

/** Applied in main so only the excerpt crosses IPC / the runtime RPC socket. */
export function toGitLabJobLogExcerptResult(result: GitLabJobTraceResult): GitLabJobTraceResult {
  return result.ok ? { ok: true, trace: gitLabJobTraceToLogExcerpt(result.trace) } : result
}
