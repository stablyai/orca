// Why: navigator.clipboard only exists in secure contexts. The web client served
// over plain HTTP (e.g. a LAN address) can write the clipboard only through
// document.execCommand('copy') on a selected element inside a user gesture —
// the copy-side counterpart of terminal-clipboard-event-paste.
export function copyClipboardTextViaExecCommand(text: string, doc: Document = document): boolean {
  if (typeof doc.execCommand !== 'function' || !doc.body) {
    return false
  }
  const previousFocus = doc.activeElement as { focus?: () => void } | null
  // Why: textarea.select() clobbers the page's DOM selection (chat/diff text,
  // not xterm's canvas-internal selection); clone ranges so cleanup restores it.
  const selection = doc.getSelection?.()
  const previousRanges: Range[] = []
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) {
      previousRanges.push(selection.getRangeAt(i).cloneRange())
    }
  }
  const textarea = doc.createElement('textarea')
  textarea.value = text
  // Why: readonly stops mobile browsers from opening a keyboard; fixed +
  // transparent keeps the helper from scrolling the page or flashing.
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  doc.body.appendChild(textarea)
  try {
    textarea.select()
    return doc.execCommand('copy') === true
  } catch {
    return false
  } finally {
    textarea.remove()
    if (selection && previousRanges.length > 0) {
      try {
        selection.removeAllRanges()
        for (const range of previousRanges) {
          selection.addRange(range)
        }
      } catch {
        /* ignore selection restore failures */
      }
    }
    previousFocus?.focus?.()
  }
}
