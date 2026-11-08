// Plain HTTP lacks navigator.clipboard; copy within a user gesture without putting copied text in the DOM.
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
    // xterm overwrites text/plain during bubbling; preventDefault cannot block later handlers, so stop them too.
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
