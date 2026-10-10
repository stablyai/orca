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
// Why: overlapping refreshes drop the first typed character (#9233); one per frame is enough.
const pendingRefocus = new WeakSet<HTMLElement>()

/** A field the OS input method composes into, whose input context can outlive its focus. */
export function isTextEntryElement(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true
  }
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type)
  }
  return target instanceof HTMLElement && target.isContentEditable
}

// Why an allowlist: date, color, range and the like never compose, and a needless refresh risks #9233.
// `type` reads back as 'text' when the attribute is missing or unknown.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'password', 'tel', 'url'])

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

  if (pendingRefocus.has(helper)) {
    return true
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
  pendingRefocus.add(helper)
  schedule(() => {
    pendingRefocus.delete(helper)
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
