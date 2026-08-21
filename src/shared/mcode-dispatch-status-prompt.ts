// Why: full MCode dispatch preambles are multi-KB (CLI instructions before
// `=== TASK ===`). A naive first-N-char fold of the agent-status prompt keeps
// only lifecycle boilerplate and drops the task body the UI needs as a
// fallback label before orchestration metadata arrives. Compact the status
// prompt so preamble detection, the live task id, and the task body all fit
// inside AGENT_STATUS_MAX_FIELD_LENGTH.

export const MCODE_DISPATCH_STATUS_PREAMBLE_PREFIX =
  'You are working inside MCode, a multi-agent IDE.'
export const MCODE_DISPATCH_STATUS_TASK_MARKER = '=== TASK ==='
const MCODE_DISPATCH_STATUS_TASK_ID_MARKER = 'Your task ID is:'
// Why: real preambles put === TASK === near the end (~4KB+). Scan past the
// normal single-line budget so the task body is still reachable for compacting.
const MCODE_DISPATCH_STATUS_SOURCE_SCAN_LIMIT = 24_576

export function isMCodeDispatchStatusPrompt(value: string): boolean {
  // Why: status payloads cross a trust boundary. Keep dispatch detection
  // bounded too, or leading whitespace can bypass the normalizer's scan cap.
  const scanEnd = Math.min(value.length, MCODE_DISPATCH_STATUS_SOURCE_SCAN_LIMIT)
  let start = 0
  while (start < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(start))) {
    start++
  }
  return (
    start + MCODE_DISPATCH_STATUS_PREAMBLE_PREFIX.length <= scanEnd &&
    value.startsWith(MCODE_DISPATCH_STATUS_PREAMBLE_PREFIX, start)
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
  const scanEnd = Math.min(value.length, MCODE_DISPATCH_STATUS_SOURCE_SCAN_LIMIT)
  // Bound leading trim to the scan window so a multi-MB paste of pure
  // whitespace cannot walk the entire string before we give up.
  let start = 0
  while (start < scanEnd && isEcmaTrimWhitespace(value.charCodeAt(start))) {
    start++
  }
  const scan = value.slice(start, scanEnd)

  let taskId = ''
  const idMarkerIndex = scan.indexOf(MCODE_DISPATCH_STATUS_TASK_ID_MARKER)
  if (idMarkerIndex !== -1) {
    const afterId = scan.slice(idMarkerIndex + MCODE_DISPATCH_STATUS_TASK_ID_MARKER.length)
    let idStart = 0
    while (idStart < afterId.length && isEcmaTrimWhitespace(afterId.charCodeAt(idStart))) {
      idStart++
    }
    const idRest = afterId.slice(idStart)
    const idEnd = idRest.search(/\s/)
    taskId = (idEnd === -1 ? idRest : idRest.slice(0, idEnd)).trim()
  }

  let taskBody = ''
  const taskMarkerIndex = findMCodeDispatchTaskMarkerIndex(scan)
  if (taskMarkerIndex !== -1) {
    const body = scan.slice(taskMarkerIndex + MCODE_DISPATCH_STATUS_TASK_MARKER.length)
    for (const line of body.split(/\r?\n/)) {
      const preview = line.trim().replace(/\s+/g, ' ')
      if (preview) {
        taskBody = preview
        break
      }
    }
  }

  // Why: keep the dispatch prefix (isMCodeDispatchPrompt) + task id (label match)
  // + task body (fallback preview) so UI helpers still work on the 200-char field.
  let compact = MCODE_DISPATCH_STATUS_PREAMBLE_PREFIX
  if (taskId) {
    compact += ` ${MCODE_DISPATCH_STATUS_TASK_ID_MARKER} ${taskId}`
  }
  if (taskBody) {
    compact += ` ${MCODE_DISPATCH_STATUS_TASK_MARKER} ${taskBody}`
  }
  return normalizeSingleLine(compact, maxLength)
}

/**
 * Locate the MCode task separator in a dispatch prompt scan window.
 * Why: base-drift commit subjects are repository-controlled and may mention
 * `=== TASK ===`. Raw multi-line preambles must use the standalone line MCode
 * emits; already-normalized single-line status previews intentionally keep the
 * marker inline so re-normalization and UI helpers stay consistent.
 */
export function findMCodeDispatchTaskMarkerIndex(value: string): number {
  let searchFrom = 0
  while (searchFrom < value.length) {
    const markerIndex = value.indexOf(MCODE_DISPATCH_STATUS_TASK_MARKER, searchFrom)
    if (markerIndex === -1) {
      break
    }
    const markerEnd = markerIndex + MCODE_DISPATCH_STATUS_TASK_MARKER.length
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
    : value.indexOf(MCODE_DISPATCH_STATUS_TASK_MARKER)
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
