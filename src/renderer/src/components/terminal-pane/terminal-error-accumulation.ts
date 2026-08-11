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

/** Appends an error to the aggregated surface, keeping the first occurrence of an already-present message. */
export function appendTerminalErrorMessage(accumulated: string | null, message: string): string {
  if (!accumulated) {
    return message
  }
  return containsWholeLineRun(accumulated, message) ? accumulated : `${accumulated}\n${message}`
}
