type TerminalOutputAckTarget = object

const inFlightAckCompletions = new WeakMap<TerminalOutputAckTarget, Set<() => void>>()

/** Tracks credits after submission to xterm so pane disposal can treat its
 * unparsed write buffer as discarded instead of leaking main's ACK window. */
export function registerTerminalOutputAckCredits(
  terminal: TerminalOutputAckTarget,
  credits: readonly (() => void)[]
): (() => void) | undefined {
  if (credits.length === 0) {
    return undefined
  }
  let completions = inFlightAckCompletions.get(terminal)
  if (!completions) {
    completions = new Set()
    inFlightAckCompletions.set(terminal, completions)
  }
  let completed = false
  const complete = (): void => {
    if (completed) {
      return
    }
    completed = true
    completions?.delete(complete)
    if (completions?.size === 0) {
      inFlightAckCompletions.delete(terminal)
    }
    for (const credit of credits) {
      credit()
    }
  }
  completions.add(complete)
  return complete
}

export function discardInFlightTerminalOutputAckCredits(terminal: TerminalOutputAckTarget): void {
  const completions = inFlightAckCompletions.get(terminal)
  if (!completions) {
    return
  }
  for (const complete of completions) {
    complete()
  }
}
