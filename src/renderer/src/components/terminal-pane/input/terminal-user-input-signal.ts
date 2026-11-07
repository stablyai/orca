import type { Terminal } from '@xterm/xterm'

// Public onData mixes typing/paste/mouse with synthetic query replies; only the private core user-input signal preserves provenance.
type TerminalWithCoreUserInput = {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => { dispose?: unknown } | undefined
    }
  }
}

/** Subscribe only to real input; return null if core API is unavailable so callers retain historical onData tracking. */
export function subscribeToTerminalUserInput(
  terminal: Terminal,
  listener: () => void
): { dispose: () => void } | null {
  const coreService = (terminal as unknown as TerminalWithCoreUserInput)._core?.coreService
  if (!coreService || typeof coreService.onUserInput !== 'function') {
    return null
  }
  try {
    const subscription = coreService.onUserInput(listener)
    // Without usable disposal callers must keep fallback, or API drift silently disables input activity.
    if (subscription && typeof subscription.dispose === 'function') {
      return subscription as { dispose: () => void }
    }
    return null
  } catch {
    return null
  }
}

/** Preserve xterm's input provenance across deferred PTY forwarding. */
export function subscribeToTerminalInputData(
  terminal: Terminal,
  listener: (data: string, wasUserInput: boolean) => void
): { dispose: () => void } {
  let pendingUserInput = false
  const userInput = subscribeToTerminalUserInput(terminal, () => {
    pendingUserInput = true
  })
  const dataInput = terminal.onData((data) => {
    const wasUserInput = pendingUserInput
    pendingUserInput = false
    listener(data, wasUserInput)
  })
  return {
    dispose: () => {
      dataInput.dispose()
      userInput?.dispose()
    }
  }
}
