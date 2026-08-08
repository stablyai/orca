// Why: the error surface aggregates every pane error into ONE newline-joined
// string so TerminalErrorToast's per-line filters (isSshReconnectOwnedTerminalError,
// stripSshReconnectOwnedErrorLines) keep working. That join makes line-based
// dedup wrong for messages that themselves contain newlines: a multi-line
// message is never one line of the accumulated value, so it would re-append on
// every recurrence and grow without bound.

/** Hard cap on the toast surface so distinct multi-error storms cannot grow unbound (#12685). */
export const MAX_TERMINAL_ERROR_SURFACE_CHARS = 2_000

function containsWholeLineRun(accumulated: string, message: string): boolean {
  return (
    accumulated === message ||
    accumulated.startsWith(`${message}\n`) ||
    accumulated.endsWith(`\n${message}`) ||
    accumulated.includes(`\n${message}\n`)
  )
}

/**
 * Bound the surface without breaking SSH ownership filters that match
 * prefixes on whole lines (#12685). Multi-message surfaces keep the newest
 * complete lines; a single oversized line keeps its head (classification
 * prefix) rather than a mid-string suffix.
 */
export function capTerminalErrorSurfaceNewest(
  text: string,
  maxChars: number = MAX_TERMINAL_ERROR_SURFACE_CHARS
): string {
  if (text.length <= maxChars) {
    return text
  }
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) {
    // One line longer than the cap: keep the identifying prefix.
    return text.slice(0, maxChars)
  }
  let start = text.length - maxChars
  const newline = text.indexOf('\n', start)
  if (newline !== -1 && newline < text.length - 1) {
    start = newline + 1
  }
  const suffix = text.slice(start)
  // Newest segment alone can still exceed the cap (multi-line or long line).
  return suffix.length <= maxChars ? suffix : suffix.slice(0, maxChars)
}

/** Appends an error to the aggregated surface, keeping the first occurrence of an already-present message. */
export function appendTerminalErrorMessage(accumulated: string | null, message: string): string {
  if (!accumulated) {
    return capTerminalErrorSurfaceNewest(message)
  }
  if (containsWholeLineRun(accumulated, message)) {
    return accumulated
  }
  return capTerminalErrorSurfaceNewest(`${accumulated}\n${message}`)
}
