// The toast still consumes newline-joined copy, so legacy tab-wide messages need
// whole-run dedup even though pane errors remain structurally separate until render.
function containsWholeLineRun(accumulated: string, message: string): boolean {
  return (
    accumulated === message ||
    accumulated.startsWith(`${message}\n`) ||
    accumulated.endsWith(`\n${message}`) ||
    accumulated.includes(`\n${message}\n`)
  )
}

export type TerminalErrorsByPaneId = Record<number, readonly string[]>
const MAX_TERMINAL_ERRORS_PER_PANE = 8
export const MAX_TERMINAL_ERROR_LINES = 24
export const MAX_TERMINAL_ERROR_CHARS = 4_000

export function boundTerminalErrorSurface(
  surface: string,
  maxLines: number = MAX_TERMINAL_ERROR_LINES,
  maxChars: number = MAX_TERMINAL_ERROR_CHARS
): string {
  const lines = surface.split('\n')
  let bounded = lines.length > maxLines ? lines.slice(-maxLines).join('\n') : surface
  if (bounded.length <= maxChars) {
    return bounded
  }
  const suffix = bounded.slice(-maxChars)
  const firstNewline = suffix.indexOf('\n')
  bounded = firstNewline === -1 ? suffix : suffix.slice(firstNewline + 1) || suffix
  return bounded
}

export function appendPaneTerminalError(
  errorsByPaneId: TerminalErrorsByPaneId,
  paneId: number,
  message: string
): TerminalErrorsByPaneId {
  const boundedMessage = boundTerminalErrorSurface(message)
  const current = errorsByPaneId[paneId] ?? []
  if (
    current.some(
      (entry) =>
        entry === boundedMessage ||
        (!boundedMessage.includes('\n') && containsWholeLineRun(entry, boundedMessage))
    )
  ) {
    return errorsByPaneId
  }
  return {
    ...errorsByPaneId,
    [paneId]: [...current.slice(-(MAX_TERMINAL_ERRORS_PER_PANE - 1)), boundedMessage]
  }
}

export function clearPaneTerminalError(
  errorsByPaneId: TerminalErrorsByPaneId,
  paneId: number,
  message?: string
): TerminalErrorsByPaneId {
  const current = errorsByPaneId[paneId]
  if (!current) {
    return errorsByPaneId
  }
  const boundedMessage = message === undefined ? undefined : boundTerminalErrorSurface(message)
  const kept =
    boundedMessage === undefined ? [] : current.filter((entry) => entry !== boundedMessage)
  if (kept.length === current.length) {
    return errorsByPaneId
  }
  const next = { ...errorsByPaneId }
  if (kept.length === 0) {
    delete next[paneId]
  } else {
    next[paneId] = kept
  }
  return next
}

export function mapPaneTerminalErrors(
  errorsByPaneId: TerminalErrorsByPaneId,
  mapMessage: (message: string) => string | null
): TerminalErrorsByPaneId {
  let next = errorsByPaneId
  for (const [rawPaneId, messages] of Object.entries(errorsByPaneId)) {
    const paneId = Number(rawPaneId)
    const mapped = messages.map(mapMessage).filter((message): message is string => message !== null)
    if (
      mapped.length === messages.length &&
      mapped.every((message, index) => message === messages[index])
    ) {
      continue
    }
    if (next === errorsByPaneId) {
      next = { ...errorsByPaneId }
    }
    if (mapped.length === 0) {
      delete next[paneId]
    } else {
      next[paneId] = mapped
    }
  }
  return next
}

export function terminalErrorForPane(
  tabError: string | null,
  errorsByPaneId: TerminalErrorsByPaneId,
  paneId: number | null
): string | null {
  const paneError = paneId === null ? null : errorsByPaneId[paneId]?.join('\n') || null
  if (!tabError) {
    return paneError ? boundTerminalErrorSurface(paneError) : null
  }
  return paneError ? appendTerminalErrorMessage(tabError, paneError) : tabError
}

/** Appends an error to the aggregated surface, keeping the first occurrence of an already-present message. */
export function appendTerminalErrorMessage(accumulated: string | null, message: string): string {
  if (!accumulated) {
    return boundTerminalErrorSurface(message)
  }
  return containsWholeLineRun(accumulated, message)
    ? accumulated
    : boundTerminalErrorSurface(`${accumulated}\n${message}`)
}
