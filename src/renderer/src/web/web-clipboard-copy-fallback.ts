// Why: navigator.clipboard only exists in secure contexts. The web client served
// over plain HTTP (e.g. a LAN address) can write the clipboard only through
// document.execCommand('copy') inside a user gesture — the copy-side counterpart
// of terminal-clipboard-event-paste.
//
// Why a copy ClipboardEvent and not a hidden textarea: serving the text from the
// event's clipboardData needs no DOM node, no selection change, and no focus
// change, so it cannot disturb the xterm helper textarea, a chat composer, or a
// page selection the user already made. It is also O(1) rather than O(text) —
// a hidden textarea forces layout/selection over the whole string, which costs
// ~1.4s for a 16 MB copy (the CLIPBOARD_TEXT_WRITE_MAX_BYTES ceiling) versus
// ~16ms here. The textarea path stays as a fallback because WebKit refuses
// execCommand('copy') when nothing is selected and nothing supplies the data.
export function copyClipboardTextViaExecCommand(text: string, doc: Document = document): boolean {
  if (typeof doc.execCommand !== 'function') {
    return false
  }
  return copyViaClipboardEvent(text, doc) || copyViaTemporaryTextarea(text, doc)
}

function copyViaClipboardEvent(text: string, doc: Document): boolean {
  if (typeof doc.addEventListener !== 'function') {
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
    // Why both checks: Chromium returns true for a no-op copy when the handler
    // never ran, so `served` is what actually proves the text was supplied.
    return doc.execCommand('copy') === true && served
  } catch {
    return false
  } finally {
    doc.removeEventListener('copy', onCopy, true)
  }
}

// Why kept: WebKit declines execCommand('copy') when there is no selection and
// no default copy target, so an explicit selection is still needed there.
function copyViaTemporaryTextarea(text: string, doc: Document): boolean {
  if (!doc.body) {
    return false
  }
  const previousFocus = doc.activeElement as { focus?: () => void } | null
  // Why clone ranges: textarea.select() clobbers the page's DOM selection
  // (chat/diff text, not xterm's canvas-internal selection).
  const selection = doc.getSelection?.()
  const previousRanges: Range[] = []
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) {
      previousRanges.push(selection.getRangeAt(i).cloneRange())
    }
  }
  const textarea = doc.createElement('textarea')
  textarea.value = text
  // Why readonly: stops mobile browsers from opening a keyboard. Fixed +
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
    // Why focus before selection: refocusing an input collapses the document
    // selection into that input, so restoring ranges first would be undone.
    previousFocus?.focus?.()
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
  }
}
