import { stripAnsiEscapeSequences } from './ansi-escape-sequences'
import { sliceCheckLogTail } from './check-job-log-tail-slice'
import type { GitLabJobTraceResult } from './gitlab-types'

// GitLab wraps collapsible sections in `section_start:<unix>:<name>\r<CSI>0K<visible header>`;
// strip only through the CR so the human-readable header on the same line survives.
const SECTION_MARKER_PREFIX_PATTERN = /^section_(?:start|end):\d+:[^\r\n]*?\r/gm
// Sections without a visible header leave a marker-only line; drop it whole.
const SECTION_MARKER_LINE_PATTERN = /^section_(?:start|end):\d+:[^\r\n]*\n?/gm

// Bound raw text before repeated stripping passes; multi-MB logs otherwise stall main just to retain a 16 KB excerpt.
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

/** Bound readable glab job traces before RPC transport, whose 1 MB frame caps reject multi-megabyte logs. */
export function gitLabJobTraceToLogExcerpt(trace: string): string {
  if (!trace) {
    return ''
  }
  // Strip ANSI first to remove erase-to-EOL; normalize CR last so marker/header boundaries remain detectable.
  const readable = stripAnsiEscapeSequences(rawTraceTail(trace))
    .replace(SECTION_MARKER_PREFIX_PATTERN, '')
    .replace(SECTION_MARKER_LINE_PATTERN, '')
    // Bare-CR progress redraws must become newlines or they defeat line-based tails.
    .replace(/\r\n?/g, '\n')
  return sliceCheckLogTail(readable).trim()
}

/** Applied in main so only the excerpt crosses IPC / the runtime RPC socket. */
export function toGitLabJobLogExcerptResult(result: GitLabJobTraceResult): GitLabJobTraceResult {
  return result.ok ? { ok: true, trace: gitLabJobTraceToLogExcerpt(result.trace) } : result
}
