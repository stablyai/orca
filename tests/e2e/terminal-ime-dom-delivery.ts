import type { TerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'

// Reconstruct textarea delivery (composition commits, non-composing insertions, plain keys, Enter→LF).
// Separate IME/compositor input that never reached the page from delivered input Orca lost.
export function readImeDomDeliveredText(trace: TerminalImeBoundaryTrace): string {
  let text = ''
  for (const event of trace.dom) {
    if (event.type === 'compositionend') {
      text += event.data ?? ''
    } else if (event.type === 'input' && event.isComposing === false) {
      // Why: X11 IBus commits through an empty compositionend followed by a plain insertText.
      text += event.inputType === 'insertText' ? (event.data ?? '') : ''
    } else if (event.type === 'keydown' && event.isComposing === false) {
      if (event.key === 'Enter') {
        text += '\n'
      } else if (event.key !== null && [...event.key].length === 1) {
        text += event.key
      }
    }
  }
  return text
}
