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

/** Hard cap on distinct newline-separated lines kept on the aggregated surface. */
export const MAX_TERMINAL_ERROR_LINES = 24

/** Closed character budget so a few huge multi-line messages cannot grow without bound. */
export const MAX_TERMINAL_ERROR_CHARS = 4_000

/**
 * Prefer newest content. Snap to a newline after truncation so per-line SSH
 * reconnect filters never see a partial leading line.
 */
export function boundTerminalErrorSurface(
  surface: string,
  maxLines: number = MAX_TERMINAL_ERROR_LINES,
  maxChars: number = MAX_TERMINAL_ERROR_CHARS
): string {
  let next = surface
  if (maxLines > 0) {
    const lines = next.split('\n')
    if (lines.length > maxLines) {
      next = lines.slice(lines.length - maxLines).join('\n')
    }
  }
  if (maxChars > 0 && next.length > maxChars) {
    const suffix = next.slice(next.length - maxChars)
    const firstNl = suffix.indexOf('\n')
    // Why: drop a clipped leading line when possible; if the suffix is one long
    // line, keep it so the newest error remains visible.
    next = firstNl === -1 ? suffix : suffix.slice(firstNl + 1) || suffix
  }
  return next
}

/** Appends an error to the aggregated surface, keeping the first occurrence of an already-present message. */
export function appendTerminalErrorMessage(accumulated: string | null, message: string): string {
  if (!accumulated) {
    return boundTerminalErrorSurface(message)
  }
  if (containsWholeLineRun(accumulated, message)) {
    return accumulated
  }
  return boundTerminalErrorSurface(`${accumulated}\n${message}`)
}
