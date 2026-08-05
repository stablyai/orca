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
 *  currently claims focus ownership — imperative focus calls (tab switch,
 *  visibility resume, setActivePane) must not steal it back onto the hidden
 *  xterm underneath. */
export function paneContainerOwnsFocus(container: HTMLElement): boolean {
  return container.querySelector(PANE_PREVENT_TERMINAL_FOCUS_SELECTOR) !== null
}

/** Whether `element` (typically a candidate .xterm-helper-textarea found via
 *  an unscoped `document.querySelector`) sits inside a pane whose app control
 *  owns focus. Global "restore terminal focus" fallbacks — command palettes,
 *  modal close, sidebar keyboard navigation — must skip such candidates
 *  rather than stealing focus back from e.g. the native chat composer. */
export function isInsideFocusOwnedPane(element: Element): boolean {
  const pane = element.closest('.pane') as HTMLElement | null
  return pane !== null && paneContainerOwnsFocus(pane)
}
