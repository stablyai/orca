import type { Terminal } from '@xterm/xterm'

/**
 * Decides whether activating a pane still owes it a terminal focus call.
 *
 * Why: `setActivePane` runs from React effects whose deps churn on unrelated
 * renders, so the already-active pane gets re-activated many times while the
 * user types. xterm's `focus()` forwards to its helper textarea, and re-focusing
 * an element that is mid-IME-composition can drop the preedit — the cost lands
 * on CJK input specifically. Skipping the call when focus is already there keeps
 * the click-to-refocus path intact while removing the redundant ones.
 */
export function shouldFocusPaneTerminal(
  textarea: HTMLTextAreaElement | undefined | null,
  activeElement: Element | null
): boolean {
  // An unopened terminal has no textarea yet; focusing is how it acquires one.
  if (!textarea) {
    return true
  }
  return activeElement !== textarea
}

/** Applies the decision above; `focus === false` opts the caller out entirely. */
export function focusPaneTerminalOnActivate(terminal: Terminal, focus: boolean | undefined): void {
  if (focus === false) {
    return
  }
  if (shouldFocusPaneTerminal(terminal.textarea, document.activeElement)) {
    terminal.focus()
  }
}
