import {
  isDocumentBodyOrNull,
  refreshTerminalImeInputContext,
  scheduleNextFrame,
  type TerminalImeInputContextRefocusScheduler
} from './terminal-ime-input-context-refresh'

export type TerminalInputFocusSync = (focused: boolean) => void
export type RefocusScheduler = TerminalImeInputContextRefocusScheduler
export const REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE = 'data-regular-terminal-input-focused'

export function isXtermHelperTextarea(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
}

export function setRegularTerminalInputFocusAttribute(focused: boolean): void {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.toggleAttribute(REGULAR_TERMINAL_INPUT_FOCUSED_ATTRIBUTE, focused)
}

export function getPaneOwnedActiveHelperTextarea(
  container: HTMLElement,
  activeElement: Element | null
): HTMLElement | null {
  if (!isXtermHelperTextarea(activeElement) || !container.contains(activeElement)) {
    return null
  }
  return activeElement
}

export function releaseTerminalFocusForOutsidePointerDown(args: {
  container: HTMLElement
  activeElement: Element | null
  pointerTarget: EventTarget | null
  syncFocused: TerminalInputFocusSync
}): boolean {
  const activeHelper = getPaneOwnedActiveHelperTextarea(args.container, args.activeElement)
  if (!activeHelper) {
    return false
  }

  if (isNode(args.pointerTarget) && args.container.contains(args.pointerTarget)) {
    return false
  }

  args.syncFocused(false)
  activeHelper.blur()
  return true
}

export function releaseTerminalFocusForWindowBlur(args: {
  container: HTMLElement
  activeElement: Element | null
  syncFocused: TerminalInputFocusSync
}): HTMLElement | null {
  // Why: return the exact helper that owned focus so window-focus reclaim can
  // refocus *that* split, not whichever helper happens to be first in the DOM
  // (a single TerminalPane hosts every split as siblings under one container).
  const releasedHelper = getPaneOwnedActiveHelperTextarea(args.container, args.activeElement)
  if (!releasedHelper) {
    return null
  }

  args.syncFocused(false)
  return releasedHelper
}

export function resyncTerminalFocusForWindowFocus(args: {
  container: HTMLElement
  activeElement: Element | null
  syncFocused: TerminalInputFocusSync
  /**
   * The exact helper textarea this pane released on window blur. When focus
   * settled on body/null during app reactivation, reclaim *this* split's
   * helper rather than whichever helper is first in the DOM.
   */
  releasedHelper?: HTMLElement | null
  /** Override the macOS check (tests). Defaults to the navigator user agent. */
  isMac?: boolean
  /** Override the refocus scheduler (tests). Defaults to requestAnimationFrame. */
  scheduleRefocus?: RefocusScheduler
}): boolean {
  const ownedActive = getPaneOwnedActiveHelperTextarea(args.container, args.activeElement)
  let helper = ownedActive
  let needsProgrammaticFocus = false

  if (!helper) {
    const ownerDocument = args.container.ownerDocument
    const releasedHelper = args.releasedHelper
    if (
      releasedHelper &&
      releasedHelper.isConnected &&
      args.container.contains(releasedHelper) &&
      isDocumentBodyOrNull(args.activeElement, ownerDocument)
    ) {
      helper = releasedHelper
      needsProgrammaticFocus = true
    } else {
      return false
    }
  }

  args.syncFocused(true)

  const reclaimedHelper = helper

  // Why: defer the reclaim refocus to the next frame and only take focus if
  // nothing newer grabbed it — so a click into the sidebar/dialog/rename input
  // during reactivation isn't yanked back into the terminal. Applies on every
  // platform (the reporter's bug is Linux); macOS additionally needs the blur
  // first to rebuild a stale NSTextInputContext (see below).
  if (needsProgrammaticFocus) {
    const schedule = args.scheduleRefocus ?? scheduleNextFrame
    schedule(() => {
      if (!reclaimedHelper.isConnected) {
        return
      }
      const active = reclaimedHelper.ownerDocument.activeElement
      if (
        active === reclaimedHelper ||
        isDocumentBodyOrNull(active, reclaimedHelper.ownerDocument)
      ) {
        reclaimedHelper.focus()
      }
    })
    return true
  }

  // Why: macOS app reactivation leaves a stale NSTextInputContext on the
  // still-focused helper (electron#32307/#34952); non-mac returns false inside.
  refreshTerminalImeInputContext(reclaimedHelper, {
    isMac: args.isMac,
    scheduleRefocus: args.scheduleRefocus
  })

  return true
}

function isNode(value: EventTarget | null): value is Node {
  return typeof Node !== 'undefined' && value instanceof Node
}
