export const TOGGLE_FLOATING_TERMINAL_EVENT = 'orca-toggle-floating-terminal'
export const OPEN_FLOATING_TERMINAL_EVENT = 'orca-open-floating-terminal'

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

export function requestOpenFloatingTerminal(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OPEN_FLOATING_TERMINAL_EVENT))
  }
}

export function consumeFloatingTerminalOpenMaximizedIntent(): boolean {
  if (openMaximizedIntentAt === null) {
    return false
  }
  const requestedAt = openMaximizedIntentAt
  openMaximizedIntentAt = null
  return Date.now() - requestedAt <= OPEN_MAXIMIZED_INTENT_TTL_MS
}

/** Why: activity/Agents View terminal links create floating browser tabs
 *  (via FLOATING_TERMINAL_WORKTREE_ID) even when the user's
 *  floatingTerminalEnabled pref is false. The panel must become visible
 *  (open + mounted) based on tab presence so the browser is usable without
 *  leaving the view. These pure fns isolate the policy for test coverage. */
export function shouldOpenFloatingTerminalOnRequest({
  enabled,
  visibleTabCount
}: {
  enabled: boolean
  visibleTabCount: number
}): boolean {
  return enabled || visibleTabCount > 0
}

export function shouldForceCloseFloatingTerminal({
  enabled,
  visibleTabCount
}: {
  enabled: boolean
  visibleTabCount: number
}): boolean {
  return !enabled && visibleTabCount === 0
}
