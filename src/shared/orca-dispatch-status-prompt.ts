// Why: full Orca dispatch preambles are multi-KB (CLI instructions before
// `=== TASK ===`). A naive first-N-char fold of the agent-status prompt keeps
// only lifecycle boilerplate and drops the task body the UI needs as a
// fallback label before orchestration metadata arrives. Compact the status
// prompt so preamble detection, the live task id, and the task body all fit
// inside AGENT_STATUS_MAX_FIELD_LENGTH.

export const ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX =
  'You are working inside Orca, a multi-agent IDE.'
export const ORCA_DISPATCH_STATUS_TASK_MARKER = '=== TASK ==='
// Why: typed, not pasted, so Claude Code honors the brief: it follows a <pasted_content> block
// only where the user's own words ask it to, and refused bare pasted briefs (STA-8200).
export const ORCA_DISPATCH_PROMPT_LEAD_LINE =
  'Please carry out this task from my Orca coordinator by following the brief I pasted below.'
const ORCA_DISPATCH_STATUS_TASK_ID_MARKER = 'Your task ID is:'
// Why: real preambles put === TASK === near the end (~4KB+). Scan past the
// normal single-line budget so the task body is still reachable for compacting.
const ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT = 24_576
const PASTED_CONTENT_OPEN_TAG = '<pasted_content'
// Why: Claude Code's tag carries only a short id; bound the search for `>`.
const PASTED_CONTENT_OPEN_TAG_MAX_LENGTH = 64

/**
 * Index of the preamble prefix, or -1. Hook prompts may carry the typed lead
 * line and Claude Code's `<pasted_content>` wrapper ahead of it, and hosts
 * without the lead line still send the bare preamble.
 */
export function findOrcaDispatchPreambleStart(value: string): number {
  // Why: status payloads cross a trust boundary. Keep dispatch detection
  // bounded too, or leading whitespace can bypass the normalizer's scan cap.
  const scanEnd = Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT)
  let start = skipTrimWhitespace(value, 0, scanEnd)
  if (value.startsWith(ORCA_DISPATCH_PROMPT_LEAD_LINE, start)) {
    start = skipTrimWhitespace(value, start + ORCA_DISPATCH_PROMPT_LEAD_LINE.length, scanEnd)
  }
  if (value.startsWith(PASTED_CONTENT_OPEN_TAG, start)) {
    const tagLength = value.slice(start, start + PASTED_CONTENT_OPEN_TAG_MAX_LENGTH).indexOf('>')
    if (tagLength === -1) {
      return -1
    }
    start = skipTrimWhitespace(value, start + tagLength + 1, scanEnd)
  }
  return start + ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX.length <= scanEnd &&
    value.startsWith(ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX, start)
    ? start
    : -1
}

function skipTrimWhitespace(value: string, from: number, scanEnd: number): number {
  let index = from
  while (index < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(index))) {
    index++
  }
  return index
}

/**
 * Collapse a multi-KB dispatch preamble into a single-line status preview that
 * still carries enough structure for UI helpers, or null when `value` is not one:
 *   `<preamble prefix> Your task ID is: <id> === TASK === <task body>`
 */
export function compactDispatchPromptForStatus(
  value: string,
  maxLength: number,
  normalizeSingleLine: (value: string, maxLength: number) => string
): string | null {
  const start = findOrcaDispatchPreambleStart(value)
  if (start === -1) {
    return null
  }
  const scan = value.slice(start, Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT))

  let taskId = ''
  const idMarkerIndex = scan.indexOf(ORCA_DISPATCH_STATUS_TASK_ID_MARKER)
  if (idMarkerIndex !== -1) {
    const afterId = scan.slice(idMarkerIndex + ORCA_DISPATCH_STATUS_TASK_ID_MARKER.length)
    let idStart = 0
    while (idStart < afterId.length && isEcmaTrimWhitespace(afterId.charCodeAt(idStart))) {
      idStart++
    }
    const idRest = afterId.slice(idStart)
    const idEnd = idRest.search(/\s/)
    taskId = (idEnd === -1 ? idRest : idRest.slice(0, idEnd)).trim()
  }

  let taskBody = ''
  const taskMarkerIndex = findOrcaDispatchTaskMarkerIndex(scan)
  if (taskMarkerIndex !== -1) {
    const body = scan.slice(taskMarkerIndex + ORCA_DISPATCH_STATUS_TASK_MARKER.length)
    for (const line of body.split(/\r?\n/)) {
      const preview = line.trim().replace(/\s+/g, ' ')
      if (preview.startsWith('</pasted_content')) {
        break
      }
      if (preview) {
        taskBody = preview
        break
      }
    }
  }

  // Why: keep the dispatch prefix (isOrcaDispatchPrompt) + task id (label match)
  // + task body (fallback preview) so UI helpers still work on the 200-char field.
  let compact = ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX
  if (taskId) {
    compact += ` ${ORCA_DISPATCH_STATUS_TASK_ID_MARKER} ${taskId}`
  }
  if (taskBody) {
    compact += ` ${ORCA_DISPATCH_STATUS_TASK_MARKER} ${taskBody}`
  }
  return normalizeSingleLine(compact, maxLength)
}

/**
 * Locate the Orca task separator in a dispatch prompt scan window.
 * Why: base-drift commit subjects are repository-controlled and may mention
 * `=== TASK ===`. Raw multi-line preambles must use the standalone line Orca
 * emits; already-normalized single-line status previews fold newlines to spaces
 * and intentionally keep the marker inline, so they anchor on the surrounding
 * whitespace instead. Both paths reject a marker embedded mid-token.
 */
export function findOrcaDispatchTaskMarkerIndex(value: string): number {
  // Single-line previews have no line breaks; the marker Orca emits is surrounded
  // by whitespace after folding, so anchor on that boundary rather than falling
  // back to a raw indexOf that a decoy `=== TASK ===` earlier in the line wins.
  const isSingleLine = !value.includes('\n') && !value.includes('\r')
  let searchFrom = 0
  while (searchFrom < value.length) {
    const markerIndex = value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER, searchFrom)
    if (markerIndex === -1) {
      break
    }
    const markerEnd = markerIndex + ORCA_DISPATCH_STATUS_TASK_MARKER.length
    const startsBoundary =
      markerIndex === 0 || isMarkerBoundary(value.charCodeAt(markerIndex - 1), isSingleLine)
    const endsBoundary =
      markerEnd === value.length || isMarkerBoundary(value.charCodeAt(markerEnd), isSingleLine)
    if (startsBoundary && endsBoundary) {
      return markerIndex
    }
    searchFrom = markerEnd
  }

  return -1
}

function isMarkerBoundary(code: number, isSingleLine: boolean): boolean {
  return isSingleLine ? isEcmaTrimWhitespace(code) : isLineBreak(code)
}

function isLineBreak(code: number): boolean {
  return code === 10 || code === 13
}

function isEcmaTrimWhitespace(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}
