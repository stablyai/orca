// Why: full Orca dispatch preambles are multi-KB (CLI instructions before
// `=== TASK ===`). A naive first-N-char fold of the agent-status prompt keeps
// only lifecycle boilerplate and drops the task body the UI needs as a
// fallback label before orchestration metadata arrives. Compact the status
// prompt so preamble detection, the live task id, and the task body all fit
// inside AGENT_STATUS_MAX_FIELD_LENGTH.

export const ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX =
  'You are working inside Orca, a multi-agent IDE.'
export const ORCA_DISPATCH_STATUS_TASK_MARKER = '=== TASK ==='
const ORCA_DISPATCH_STATUS_TASK_ID_MARKER = 'Your task ID is:'
// Why: real preambles put === TASK === near the end (~4KB+). Scan past the
// normal single-line budget so the task body is still reachable for compacting.
const ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT = 24_576

export function isOrcaDispatchStatusPrompt(value: string): boolean {
  // Why: status payloads cross a trust boundary. Keep dispatch detection
  // bounded too, or leading whitespace can bypass the normalizer's scan cap.
  const scanEnd = Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT)
  let start = 0
  while (start < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(start))) {
    start++
  }
  return (
    start + ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX.length <= scanEnd &&
    value.startsWith(ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX, start)
  )
}

/**
 * Collapse a multi-KB dispatch preamble into a single-line status preview that
 * still carries enough structure for UI helpers:
 *   `<preamble prefix> Your task ID is: <id> === TASK === <task body>`
 */
export function compactDispatchPromptForStatus(
  value: string,
  maxLength: number,
  normalizeSingleLine: (value: string, maxLength: number) => string
): string {
  const scanEnd = Math.min(value.length, ORCA_DISPATCH_STATUS_SOURCE_SCAN_LIMIT)
  // Bound leading trim to the scan window so a multi-MB paste of pure
  // whitespace cannot walk the entire string before we give up.
  let start = 0
  while (start < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(start))) {
    start++
  }
  const scan = value.slice(start, scanEnd)

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
