// The always-mounted worktree sidebar is page chrome, not an Escape-owning popup.
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="listbox"]:not([data-worktree-sidebar]), [role="menu"]'

type VisibleOverlayOptions = {
  /** Overlays inside a match are treated as page content, not as a layer above it. */
  ignoreSelector?: string
  /** Ignore matching chrome itself while retaining overlays nested within it. */
  ignoreMatches?: string
  /** A terminal hosted inside an overlay may still take focus within that overlay. */
  ignoreContaining?: Element
  /** An overlay animating out no longer outranks focus that was queued before it closed. */
  ignoreDismissed?: boolean
}

/** Live overlays own Escape before page handlers and outrank queued terminal focus. Ignore page chrome while retaining nested layers. */
export function hasVisibleOverlay(options?: VisibleOverlayOptions): boolean {
  return Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some((element) => {
    if (!(element instanceof HTMLElement)) {
      return false
    }
    if (element.closest('[aria-hidden="true"]')) {
      return false
    }
    if (options?.ignoreSelector && element.closest(options.ignoreSelector)) {
      return false
    }
    if (options?.ignoreMatches && element.matches(options.ignoreMatches)) {
      return false
    }
    if (options?.ignoreContaining && element.contains(options.ignoreContaining)) {
      return false
    }
    // Dismissed overlays remain painted during ~300ms exit animation; exclude them from focus ownership. Escape checks run before closed attributes update and must opt out.
    if (options?.ignoreDismissed && element.getAttribute('data-state') === 'closed') {
      return false
    }
    const style = window.getComputedStyle(element)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    )
  })
}
