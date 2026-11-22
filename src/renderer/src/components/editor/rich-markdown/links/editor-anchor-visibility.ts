const VISIBILITY_ATTRIBUTES = ['aria-hidden', 'class', 'hidden', 'inert', 'style']

// Hidden workspaces may stay painted (opacity-0 + inert) rather than display:none, so walk ancestors.
export function isEditorAnchorVisible(anchorElement: HTMLElement): boolean {
  if (!anchorElement.isConnected || anchorElement.getClientRects().length === 0) {
    return false
  }
  for (let element: HTMLElement | null = anchorElement; element; element = element.parentElement) {
    const style = window.getComputedStyle(element)
    if (
      element.hidden ||
      element.inert ||
      element.getAttribute('aria-hidden') === 'true' ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number.parseFloat(style.opacity) === 0
    ) {
      return false
    }
  }
  return true
}

export function observeAnchorAncestorVisibility(
  observer: MutationObserver,
  anchorElement: HTMLElement
): void {
  for (let element: HTMLElement | null = anchorElement; element; element = element.parentElement) {
    observer.observe(element, { attributes: true, attributeFilter: VISIBILITY_ATTRIBUTES })
  }
}
