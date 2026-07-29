import type { Terminal } from '@xterm/xterm'

// Why: xterm's public onData stream mixes real user input (keyboard, IME,
// paste, mouse reports) with parser-generated auto-replies (focus in/out
// reports, DA/DSR/CPR query responses). The core service already classifies
// the two — its onUserInput event fires only for real input — but that
// classification is not exposed on the public API.
type TerminalWithCoreUserInput = {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => { dispose?: unknown } | undefined
    }
  }
}

/**
 * Subscribe to xterm's core user-input signal. Fires only for real user
 * input, never for the emulator's synthetic query replies that also flow
 * through onData.
 *
 * Returns null when the internal API is unavailable (e.g. after an xterm
 * upgrade) so callers can fall back to onData-based recording — degrading to
 * the historical behavior instead of losing input tracking.
 */
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
    // Why: a reshaped internal that subscribes but returns no disposable must
    // not be treated as live — callers disable their onData fallback on a
    // non-null return, and activity tracking would silently disappear.
    if (subscription && typeof subscription.dispose === 'function') {
      return subscription as { dispose: () => void }
    }
    return null
  } catch {
    return null
  }
}
