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
// Why: between the refresh blur and its refocus frame the document reports body as active, yet
// the helper still owns keyboard focus; other panes' recovery must not read that gap as free.
// Only the newest refresh request counts: an older callback must neither clear it nor refocus.
type PendingImeRefocus = { helper: HTMLElement; token: number }
let pendingRefocus: PendingImeRefocus | null = null
let refocusTokens = 0

export function isTerminalImeInputContextRefreshing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && refreshingHelpers.has(target)
}

/** The helper whose refresh blurred it and whose refocus frame has not run yet. */
export function terminalHelperAwaitingImeRefocus(): HTMLElement | null {
  // Why: a hidden window defers the refocus frame; a helper unmounted meanwhile owns nothing.
  if (pendingRefocus && !pendingRefocus.helper.isConnected) {
    pendingRefocus = null
  }
  return pendingRefocus?.helper ?? null
}

/** Body/null focus that no terminal is about to take back (`except` ignores one helper's refresh). */
export function isTerminalFocusUnclaimed(
  activeElement: Element | null,
  ownerDocument: Document,
  except: HTMLElement | null = null
): boolean {
  if (!isDocumentBodyOrNull(activeElement, ownerDocument)) {
    return false
  }
  const awaiting = terminalHelperAwaitingImeRefocus()
  return awaiting === null || awaiting === except
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
  const token = ++refocusTokens
  pendingRefocus = { helper, token }

  const schedule = options.scheduleRefocus ?? scheduleNextFrame
  schedule(() => {
    if (pendingRefocus?.token !== token) {
      // Why: a newer refresh owns the refocus; this request is stale. This helper's own newer
      // gap is not a lost focus, but another helper's pending refocus is: report that helper as
      // the settled owner so consumers (floating focus reporting) release this one.
      const active = ownerDocument.activeElement
      const newer = terminalHelperAwaitingImeRefocus()
      if (isDocumentBodyOrNull(active, ownerDocument)) {
        if (newer === helper) {
          return
        }
        options.onRefocusSkipped?.(newer ?? active)
        return
      }
      options.onRefocusSkipped?.(active)
      return
    }
    pendingRefocus = null
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
