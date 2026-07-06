export type TerminalImeInputContextRefocusScheduler = (callback: () => void) => void

export type TerminalImeInputContextRefreshOptions = {
  /** Override the macOS check (tests). Defaults to the navigator user agent. */
  isMac?: boolean
  /** Override the refocus scheduler (tests). Defaults to requestAnimationFrame. */
  scheduleRefocus?: TerminalImeInputContextRefocusScheduler
}

function isMacUserAgent(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function scheduleNextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback)
  } else {
    setTimeout(callback, 0)
  }
}

export function isDocumentBodyOrNull(
  activeElement: Element | null,
  ownerDocument: Document
): boolean {
  return activeElement === null || activeElement === ownerDocument.body
}

export function refreshTerminalImeInputContext(
  helper: HTMLElement,
  options: TerminalImeInputContextRefreshOptions
): boolean {
  const isMac = options.isMac ?? isMacUserAgent()
  if (!isMac || !helper.isConnected) {
    return false
  }

  const ownerDocument = helper.ownerDocument
  // Why: Electron/Chromium can keep a stale NSTextInputContext on the xterm
  // helper after focus handoffs; blur/refocus rebuilds it so CJK IMEs work.
  helper.blur()

  const schedule = options.scheduleRefocus ?? scheduleNextFrame
  schedule(() => {
    const active = ownerDocument.activeElement
    if (!helper.isConnected) {
      return
    }
    if (active === helper || isDocumentBodyOrNull(active, ownerDocument)) {
      helper.focus()
    }
  })

  return true
}
