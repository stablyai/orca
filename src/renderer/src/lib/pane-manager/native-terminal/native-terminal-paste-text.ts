// Text a native view received to paste (a Services menu result). The pane's paste listeners
// run it through the same pipeline as Edit > Paste.
export const NATIVE_TERMINAL_PASTE_TEXT_EVENT = 'orca:native-terminal-paste-text'

export function dispatchNativeTerminalPasteText(target: HTMLElement, text: string): void {
  target.dispatchEvent(
    new CustomEvent(NATIVE_TERMINAL_PASTE_TEXT_EVENT, { bubbles: true, detail: text })
  )
}

export function readNativeTerminalPasteText(event: Event): string | null {
  return event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : null
}
