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

/**
 * Whether a dialog, alert dialog, listbox, or menu is on screen. Page-level Escape
 * handlers ask this before acting: the overlay owns the first Escape, and a page
 * that preventDefaults instead vetoes the overlay's own dismissal. Terminal focus
 * asks the same question: a live overlay outranks a queued pane focus.
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
    if (options?.ignoreMatches && element.matches(options.ignoreMatches)) {
      return false
    }
    if (options?.ignoreContaining && element.contains(options.ignoreContaining)) {
      return false
    }
    // Why: overlays stay mounted and painted through their exit animation, so a
    // dismissed one would otherwise keep owning a queued focus for ~300ms. Escape
    // callers opt out: they run before the attribute flips, so it only ever hides
    // a still-open overlay from them.
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

// These don't own Escape, but still paint above pages: popper surfaces (tooltips, hover cards),
// toasts, modal backdrops and the floating workspace.
const OVERLAY_LAYER_SELECTOR = `${OVERLAY_SELECTOR}, [data-radix-popper-content-wrapper], [data-sonner-toast], [data-slot$="-overlay"], [data-floating-terminal-panel]`

/** Whether any overlay paints over `owner`'s `rect`; a native view there would hide it. Layers
 *  holding `owner`, like a floating workspace showing the page, are under it, not over it. */
export function hasVisibleOverlayOver(rect: DOMRectReadOnly, owner: Element): boolean {
  return Array.from(document.querySelectorAll(OVERLAY_LAYER_SELECTOR)).some((element) => {
    // Painted, not accessible: a modal's hideOthers() marks its own backdrop aria-hidden.
    if (
      element.contains(owner) ||
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false
    }
    const box = element.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left < rect.right &&
      box.right > rect.left &&
      box.top < rect.bottom &&
      box.bottom > rect.top
    )
  })
}
