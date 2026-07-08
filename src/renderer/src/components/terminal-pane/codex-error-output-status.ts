import { stripTerminalControl } from './terminal-control-sequence-strip'

type CodexErrorOutputStatusDetector = {
  observe: (data: string) => boolean
  reset: () => void
}

const CODEX_STREAM_DISCONNECTED_MARKER = 'stream disconnected before completion:'
const MARKER_SEAM_LENGTH = CODEX_STREAM_DISCONNECTED_MARKER.length - 1
const MAX_PENDING_STREAM_ERROR_LINE_LENGTH = 8_000
// Why: the fatal line's prefix (quote, grep filename, echo chrome) can land in
// an earlier chunk than the marker; keep the unterminated line's tail so the
// prefix check still sees it after a chunk split.
const LINE_CONTEXT_LIMIT = 300
const RETRY_NOTICE_RE = /;\s*retrying\b/

function updateLineContext(lineContext: string, data: string): string {
  const lastTerminator = Math.max(data.lastIndexOf('\r'), data.lastIndexOf('\n'))
  if (lastTerminator >= 0) {
    return data.length - (lastTerminator + 1) > LINE_CONTEXT_LIMIT
      ? data.slice(-LINE_CONTEXT_LIMIT)
      : data.slice(lastTerminator + 1)
  }
  if (data.length >= LINE_CONTEXT_LIMIT) {
    return data.slice(-LINE_CONTEXT_LIMIT)
  }
  return (lineContext + data).slice(-LINE_CONTEXT_LIMIT)
}

// Why: a bare \r truncates the extracted message at the first wrapped or
// redrawn row; acceptable for a repair heuristic — the state fix still lands.
function findLineEnd(value: string, start: number): number {
  const carriageReturnIndex = value.indexOf('\r', start)
  const newlineIndex = value.indexOf('\n', start)
  if (carriageReturnIndex === -1) {
    return newlineIndex
  }
  if (newlineIndex === -1) {
    return carriageReturnIndex
  }
  return Math.min(carriageReturnIndex, newlineIndex)
}

function findLineStart(value: string, markerIndex: number): number {
  const previousCarriageReturn = value.lastIndexOf('\r', markerIndex)
  const previousNewline = value.lastIndexOf('\n', markerIndex)
  return Math.max(previousCarriageReturn, previousNewline) + 1
}

function isLikelyCodexFatalLinePrefix(prefix: string): boolean {
  // Why: codex renders the fatal cell as "■ {message}" (or the bare line in
  // exec mode); echoes of the error text — exec-output "└"/indent rows,
  // queued-prompt "›", quotes, grep output — must not complete a live turn.
  return prefix === '' || prefix.trim() === '■'
}

function normalizeStreamErrorLine(line: string): string | null {
  const strippedLine = stripTerminalControl(line)
  const markerIndex = strippedLine.indexOf(CODEX_STREAM_DISCONNECTED_MARKER)
  if (markerIndex === -1) {
    return null
  }
  if (!isLikelyCodexFatalLinePrefix(strippedLine.slice(0, markerIndex))) {
    return null
  }
  const message = strippedLine.slice(markerIndex).replace(/\s+/g, ' ').trim()
  if (!message || RETRY_NOTICE_RE.test(message)) {
    return null
  }
  return message
}

function findCompletedStreamErrorLine(rawText: string): {
  message: string | null
  pendingLine: string | null
} {
  let searchStart = 0
  while (searchStart < rawText.length) {
    const markerIndex = rawText.indexOf(CODEX_STREAM_DISCONNECTED_MARKER, searchStart)
    if (markerIndex === -1) {
      return { message: null, pendingLine: null }
    }
    const lineStart = findLineStart(rawText, markerIndex)
    const lineEnd = findLineEnd(rawText, markerIndex)
    if (lineEnd === -1) {
      const pendingLine = rawText.slice(lineStart)
      const message = normalizeStreamErrorLine(pendingLine)
      return message
        ? { message: null, pendingLine: pendingLine.slice(0, MAX_PENDING_STREAM_ERROR_LINE_LENGTH) }
        : { message: null, pendingLine: null }
    }

    const message = normalizeStreamErrorLine(rawText.slice(lineStart, lineEnd))
    if (message) {
      return { message, pendingLine: null }
    }
    searchStart = markerIndex + CODEX_STREAM_DISCONNECTED_MARKER.length
  }
  return { message: null, pendingLine: null }
}

export function createCodexErrorOutputStatusDetector(args: {
  onStreamError: (message: string) => void
}): CodexErrorOutputStatusDetector {
  let lineContext = ''
  let pendingLine: string | null = null

  const reset = (): void => {
    lineContext = ''
    pendingLine = null
  }

  const scanForCompletedLine = (rawText: string): boolean => {
    const result = findCompletedStreamErrorLine(rawText)
    pendingLine = result.pendingLine
    if (!result.message) {
      return false
    }
    args.onStreamError(result.message)
    return true
  }

  return {
    observe(data: string): boolean {
      if (pendingLine !== null) {
        const combined = (pendingLine + data).slice(0, MAX_PENDING_STREAM_ERROR_LINE_LENGTH)
        const lineEnd = findLineEnd(combined, 0)
        lineContext = updateLineContext(lineContext, data)
        if (lineEnd === -1 && combined.length < MAX_PENDING_STREAM_ERROR_LINE_LENGTH) {
          pendingLine = combined
          return false
        }
        pendingLine = null
        const message = normalizeStreamErrorLine(
          lineEnd === -1 ? combined : combined.slice(0, lineEnd)
        )
        if (message) {
          args.onStreamError(message)
          return true
        }
        // Why: a pending line can resolve into a rejected retry notice whose
        // chunk already carries the real fatal line — rescan the remainder.
        return lineEnd === -1 ? false : scanForCompletedLine(combined.slice(lineEnd + 1))
      }

      const previousLineContext = lineContext
      lineContext = updateLineContext(previousLineContext, data)
      if (!data.includes(CODEX_STREAM_DISCONNECTED_MARKER)) {
        if (
          previousLineContext === '' ||
          !(
            previousLineContext.slice(-MARKER_SEAM_LENGTH) + data.slice(0, MARKER_SEAM_LENGTH)
          ).includes(CODEX_STREAM_DISCONNECTED_MARKER)
        ) {
          return false
        }
      }
      // Why: prepend the current line's earlier chunks so a marker at the
      // chunk edge keeps its true prefix and seam-split markers complete.
      return scanForCompletedLine(previousLineContext + data)
    },
    reset
  }
}
