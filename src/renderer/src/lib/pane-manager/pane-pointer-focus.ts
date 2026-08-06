const PANE_PREVENT_TERMINAL_FOCUS_SELECTOR = '[data-pane-prevent-terminal-focus]'

const APP_CONTROL_SELECTOR = [
  'input:not(.xterm-helper-textarea)',
  'textarea:not(.xterm-helper-textarea)',
  'select',
  'button',
  '[role="textbox"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  PANE_PREVENT_TERMINAL_FOCUS_SELECTOR
].join(',')

export function shouldFocusTerminalFromPanePointerDown(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return true
  }

  // Why: pane-local app controls (for example the title editor) are portaled
  // into the pane container; focusing xterm from their pointerdown blurs them.
  return target.closest(APP_CONTROL_SELECTOR) === null
}

/** Whether a pane's own app control (e.g. the native chat composer overlay)
 *  currently claims focus ownership. Imperative focus paths route through
 *  focusPaneSurface (pane-surface-focus.ts), which uses this to pick the
 *  owning surface instead of the hidden xterm. */
export function paneContainerOwnsFocus(container: HTMLElement): boolean {
  return container.querySelector(PANE_PREVENT_TERMINAL_FOCUS_SELECTOR) !== null
}
