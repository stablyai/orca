export const TOGGLE_FLOATING_TERMINAL_EVENT = 'orca-toggle-floating-terminal'

// Why: maximize/restore lives in the panel's own keydown handler, but that
// handler is unmounted while the panel is closed. When Cmd+Opt+Shift+A is
// pressed with the panel closed, App opens it and records a one-shot intent
// here so the freshly mounted panel starts maximized instead of at its last
// saved size. A module singleton (not a prop) bridges the closed→mounted gap
// that React state cannot, and is consumed exactly once.
let openMaximizedIntentAt: number | null = null

// Why: the panel mounts within the same interaction as the request, so an
// intent older than this window means the open was abandoned (prevented or
// interrupted before mount). Expiring it stops a stale intent from leaking
// into a later ordinary open and maximizing it unexpectedly.
const OPEN_MAXIMIZED_INTENT_TTL_MS = 2000

export function requestFloatingTerminalOpenMaximized(): void {
  openMaximizedIntentAt = Date.now()
}

export function consumeFloatingTerminalOpenMaximizedIntent(): boolean {
  if (openMaximizedIntentAt === null) {
    return false
  }
  const requestedAt = openMaximizedIntentAt
  openMaximizedIntentAt = null
  return Date.now() - requestedAt <= OPEN_MAXIMIZED_INTENT_TTL_MS
}
