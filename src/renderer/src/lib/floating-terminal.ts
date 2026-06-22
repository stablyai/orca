export const TOGGLE_FLOATING_TERMINAL_EVENT = 'orca-toggle-floating-terminal'

// Why: maximize/restore lives in the panel's own keydown handler, but that
// handler is unmounted while the panel is closed. When Cmd+Opt+Shift+A is
// pressed with the panel closed, App opens it and records a one-shot intent
// here so the freshly mounted panel starts maximized instead of at its last
// saved size. A module singleton (not a prop) bridges the closed→mounted gap
// that React state cannot, and is consumed exactly once.
let openMaximizedIntent = false

export function requestFloatingTerminalOpenMaximized(): void {
  openMaximizedIntent = true
}

export function consumeFloatingTerminalOpenMaximizedIntent(): boolean {
  if (!openMaximizedIntent) {
    return false
  }
  openMaximizedIntent = false
  return true
}
