// Why: navigator.clipboard only exists in secure contexts. The web client served
// over plain HTTP can copy through a copy event inside a user gesture without
// exposing the copied text in the page DOM.
export function copyClipboardTextViaExecCommand(text: string, doc: Document = document): boolean {
  if (typeof doc.execCommand !== 'function' || typeof doc.addEventListener !== 'function') {
    return false
  }
  let served = false
  const onCopy = (event: ClipboardEvent): void => {
    if (!event.clipboardData) {
      return
    }
    event.clipboardData.setData('text/plain', text)
    // Why bubble + stop: xterm's listener on terminal.element overwrites text/plain,
    // and preventDefault alone does not stop it or any later window-level handler.
    event.stopImmediatePropagation()
    event.preventDefault()
    served = true
  }
  doc.addEventListener('copy', onCopy)
  try {
    // Chromium can return true even when no handler supplied clipboard data.
    return doc.execCommand('copy') === true && served
  } catch {
    return false
  } finally {
    doc.removeEventListener('copy', onCopy)
  }
}
