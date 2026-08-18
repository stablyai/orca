// Why: the error surface aggregates every pane error into ONE newline-joined
// string so TerminalErrorToast's per-line filters (isSshReconnectOwnedTerminalError,
// stripSshReconnectOwnedErrorLines) keep working. That join makes line-based
// dedup wrong for messages that themselves contain newlines: a multi-line
// message is never one line of the accumulated value, so it would re-append on
// every recurrence and grow without bound.
function containsWholeLineRun(accumulated: string, message: string): boolean {
  return (
    accumulated === message ||
    accumulated.startsWith(`${message}\n`) ||
    accumulated.endsWith(`\n${message}`) ||
    accumulated.includes(`\n${message}\n`)
  )
}

// Why (#15241): a recurring error that differs slightly each time (embedded timestamp, port,
// attempt count) never matches containsWholeLineRun's exact-content check, so it kept
// appending forever — a real ~3.4GB renderer leak from one flaky/reconnecting transport.
// Bound the surface to the most recent lines so both the string size and the cost of each
// `${accumulated}\n${message}` copy stay O(MAX_ACCUMULATED_LINES) instead of O(n)/O(n²).
const MAX_ACCUMULATED_LINES = 20

function truncateToMostRecentLines(value: string): string {
  const lines = value.split('\n')
  return lines.length > MAX_ACCUMULATED_LINES
    ? lines.slice(lines.length - MAX_ACCUMULATED_LINES).join('\n')
    : value
}

/**
 * Appends an error to the aggregated surface, keeping the first occurrence of an
 * already-present message. Bounded to the most recent MAX_ACCUMULATED_LINES lines so a
 * recurring near-duplicate error (see #15241) can't grow the surface without bound.
 */
export function appendTerminalErrorMessage(accumulated: string | null, message: string): string {
  if (!accumulated) {
    return message
  }
  if (containsWholeLineRun(accumulated, message)) {
    return accumulated
  }
  return truncateToMostRecentLines(`${accumulated}\n${message}`)
}
