import { isCurrentPlatformIosWeb } from '@/app-shell/platform/ios-web-platform'

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
// Why: overlapping refreshes drop the first typed character (#9233), so requests in one frame share a refocus.
const pendingRefocusSkipHandlers = new WeakMap<HTMLElement, ((active: Element | null) => void)[]>()

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

/** The helper is blurred only until its scheduled refocus, so callers can treat it as focused. */
export function isTerminalImeInputContextRefocusPending(helper: HTMLElement): boolean {
  return pendingRefocusSkipHandlers.has(helper)
}

// Why not iOS web: its UA also says Mac, and a blur there drops the on-screen keyboard for good.
function isMacUserAgent(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Mac') &&
    !isCurrentPlatformIosWeb()
  )
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

  const pendingSkipHandlers = pendingRefocusSkipHandlers.get(helper)
  if (pendingSkipHandlers) {
    if (options.onRefocusSkipped) {
      pendingSkipHandlers.push(options.onRefocusSkipped)
    }
    return true
  }
  const ownerDocument = helper.ownerDocument
  // Blur/refocus rebuilds stale macOS NSTextInputContext after xterm focus handoffs so CJK input resumes.
  refreshingHelpers.add(helper)
  try {
    helper.blur()
  } finally {
    refreshingHelpers.delete(helper)
  }

  const schedule = options.scheduleRefocus ?? scheduleNextFrame
  const skipHandlers = options.onRefocusSkipped ? [options.onRefocusSkipped] : []
  pendingRefocusSkipHandlers.set(helper, skipHandlers)
  const refocusSkipped = (active: Element | null): void => {
    for (const handler of skipHandlers) {
      handler(active)
    }
  }
  schedule(() => {
    pendingRefocusSkipHandlers.delete(helper)
    if (!helper.isConnected) {
      refocusSkipped(ownerDocument.activeElement)
      return
    }
    const active = ownerDocument.activeElement
    if (active === helper || isDocumentBodyOrNull(active, ownerDocument)) {
      helper.focus()
      if (ownerDocument.activeElement !== helper) {
        refocusSkipped(ownerDocument.activeElement)
      }
      return
    }
    refocusSkipped(active)
  })

  return true
}
