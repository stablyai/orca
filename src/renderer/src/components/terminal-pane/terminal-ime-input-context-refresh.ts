export type TerminalImeInputContextRefocusScheduler = (callback: () => void) => void

export type TerminalImeInputContextRefreshOptions = {
  /** Override the macOS check (tests). Defaults to the navigator user agent. */
  isMac?: boolean
  /** Called with the settled owner when the scheduled refocus does not land. */
  onRefocusSkipped?: (activeElement: Element | null) => void
  /** Override the refocus scheduler (tests). Defaults to requestAnimationFrame. */
  scheduleRefocus?: TerminalImeInputContextRefocusScheduler
}

const refreshingHelpers = new WeakSet<HTMLElement>()

export function isTerminalImeInputContextRefreshing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && refreshingHelpers.has(target)
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
  refreshingHelpers.add(helper)
  try {
    helper.blur()
  } finally {
    refreshingHelpers.delete(helper)
  }

  const schedule = options.scheduleRefocus ?? scheduleNextFrame
  schedule(() => {
    if (!helper.isConnected) {
      options.onRefocusSkipped?.(ownerDocument.activeElement)
      return
    }
    const active = ownerDocument.activeElement
    if (active === helper || isDocumentBodyOrNull(active, ownerDocument)) {
      helper.focus()
      if (ownerDocument.activeElement !== helper) {
        options.onRefocusSkipped?.(ownerDocument.activeElement)
      }
      return
    }
    options.onRefocusSkipped?.(active)
  })

  return true
}
