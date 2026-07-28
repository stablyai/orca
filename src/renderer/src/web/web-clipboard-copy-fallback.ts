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
    event.preventDefault()
    served = true
  }
  // Why capture: run before any app-level copy handler so the terminal text wins.
  doc.addEventListener('copy', onCopy, true)
  try {
    // Chromium can return true even when no handler supplied clipboard data.
    return doc.execCommand('copy') === true && served
  } catch {
    return false
  } finally {
    doc.removeEventListener('copy', onCopy, true)
  }
}
