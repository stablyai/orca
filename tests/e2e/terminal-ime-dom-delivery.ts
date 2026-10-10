import type { TerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'

/**
 * Reconstructs the text the input method and compositor actually handed the terminal textarea:
 * committed compositions, committed non-composing insertions and plain key presses, with Enter
 * as a line feed. Comparing it with the expected line separates input that never reached the
 * page (an IBus/compositor drop Orca cannot see) from input Orca received and then lost.
 */
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
