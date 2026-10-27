// Compact multi-KB dispatch boilerplate so preamble identity, task id and task-body fallback all fit AGENT_STATUS_MAX_FIELD_LENGTH.

export const ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX =
  'You are working inside Orca, a multi-agent IDE.'
export const ORCA_DISPATCH_STATUS_TASK_MARKER = '=== TASK ==='
// Type this lead: Claude follows pasted briefs only when user prose explicitly asks; bare pasted_content was refused (STA-8200).
export const ORCA_DISPATCH_PROMPT_LEAD_LINE =
  'Please carry out this task from my Orca coordinator by following the brief I pasted below.'
const ORCA_DISPATCH_STATUS_TASK_ID_MARKER = 'Your task ID is:'
// Real task markers follow 4KB+ preambles; scan beyond the one-line preview budget to reach the body.
const ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT = 24_576
const PASTED_CONTENT_OPEN_TAG = '<pasted_content'
// Why: Claude Code's tag carries only a short id; bound the search for `>`.
const PASTED_CONTENT_OPEN_TAG_MAX_LENGTH = 64

/** Find preamble start or -1 through optional typed lead/pasted_content wrappers, including older hosts’ bare preambles. */
export function findOrcaDispatchPreambleStart(value: string): number {
  // Bound trusted-shape detection too: arbitrary leading whitespace must not bypass the status normalizer’s scan cap.
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

/** Single-line <prefix> Your task ID is: <id> === TASK === <body> status preview; null for non-dispatch prompts. */
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

  // Retain preamble identity, task-label id and fallback body inside the 200-character status field.
  let compact = ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX
  if (taskId) {
    compact += ` ${ORCA_DISPATCH_STATUS_TASK_ID_MARKER} ${taskId}`
  }
  if (taskBody) {
    compact += ` ${ORCA_DISPATCH_STATUS_TASK_MARKER} ${taskBody}`
  }
  return normalizeSingleLine(compact, maxLength)
}

/** Require standalone === TASK === in multiline preambles because repository-controlled commit subjects may quote it.
 * Normalized single-line previews retain inline markers for idempotent cross-hop/UI reads. */
export function findOrcaDispatchTaskMarkerIndex(value: string): number {
  let searchFrom = 0
  while (searchFrom < value.length) {
    const markerIndex = value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER, searchFrom)
    if (markerIndex === -1) {
      break
    }
    const markerEnd = markerIndex + ORCA_DISPATCH_STATUS_TASK_MARKER.length
    const startsLine = markerIndex === 0 || isLineBreak(value.charCodeAt(markerIndex - 1))
    const endsLine = markerEnd === value.length || isLineBreak(value.charCodeAt(markerEnd))
    if (startsLine && endsLine) {
      return markerIndex
    }
    searchFrom = markerEnd
  }

  // Already-normalized dispatch previews are single-line and intentionally
  // carry the marker inline; normalization must stay idempotent across hops.
  return value.includes('\n') || value.includes('\r')
    ? -1
    : value.indexOf(ORCA_DISPATCH_STATUS_TASK_MARKER)
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
