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
  // Return the exact owning helper; sibling splits share a container, so first-match lookup targets the wrong pane.
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
  /** Reclaim the exact helper released on blur only if reactivation leaves body/null focused. */
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

  const reclaimedHelper = helper

  // Reclaim next frame only without a newer owner; macOS also blurs first to rebuild stale NSTextInputContext.
  if (needsProgrammaticFocus) {
    const schedule = args.scheduleRefocus ?? scheduleNextFrame
    schedule(() => {
      if (!reclaimedHelper.isConnected) {
        syncFocusAfterFailedReclaim(reclaimedHelper.ownerDocument.activeElement, args.syncFocused)
        return
      }
      const active = reclaimedHelper.ownerDocument.activeElement
      if (
        active === reclaimedHelper ||
        isDocumentBodyOrNull(active, reclaimedHelper.ownerDocument)
      ) {
        reclaimedHelper.focus()
        if (reclaimedHelper.ownerDocument.activeElement === reclaimedHelper) {
          args.syncFocused(true)
        } else {
          syncFocusAfterFailedReclaim(reclaimedHelper.ownerDocument.activeElement, args.syncFocused)
        }
        return
      }
      syncFocusAfterFailedReclaim(active, args.syncFocused)
    })
    return true
  }

  args.syncFocused(true)

  // Why: macOS app reactivation leaves a stale NSTextInputContext on the
  // still-focused helper (electron#32307/#34952); non-mac returns false inside.
  refreshTerminalImeInputContext(reclaimedHelper, {
    isMac: args.isMac,
    // If another control wins during refresh, update the terminal ownership mirror accordingly.
    onRefocusSkipped: (active) => syncFocusAfterFailedReclaim(active, args.syncFocused),
    scheduleRefocus: args.scheduleRefocus
  })

  return true
}

function syncFocusAfterFailedReclaim(
  activeElement: Element | null,
  syncFocused: TerminalInputFocusSync
): void {
  // Older deferred reclaim cannot overwrite a newer xterm focusin ownership publication.
  if (!isXtermHelperTextarea(activeElement)) {
    syncFocused(false)
  }
}

function isNode(value: EventTarget | null): value is Node {
  return typeof Node !== 'undefined' && value instanceof Node
}
