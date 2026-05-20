const APP_CONTROL_SELECTOR = [
  'input:not(.xterm-helper-textarea)',
  'textarea:not(.xterm-helper-textarea)',
  'select',
  'button',
  '[role="textbox"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[data-pane-prevent-terminal-focus]'
].join(',')

export function shouldFocusTerminalFromPanePointerDown(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return true
  }

  // Why: pane-local app controls (for example the title editor) are portaled
  // into the pane container; focusing xterm from their pointerdown blurs them.
  return target.closest(APP_CONTROL_SELECTOR) === null
}
