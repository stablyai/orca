const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'

type VisibleOverlayOptions = {
  /** Overlays inside a match are treated as page content, not as a layer above it. */
  ignoreSelector?: string
}

/**
 * Whether a dialog, alert dialog, listbox, or menu is on screen. Page-level Escape
 * handlers ask this before acting: the overlay owns the first Escape, and a page
 * that preventDefaults instead vetoes the overlay's own dismissal.
 */
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
    const style = window.getComputedStyle(element)
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      element.getClientRects().length > 0
    )
  })
}
