function isShown(element: Element | null | undefined): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    element.offsetParent !== null &&
    getComputedStyle(element).visibility !== 'hidden'
  )
}

/**
 * Focus for when a dialog opened from the pane's ⋯ closes: the opening menu row is gone by then.
 * Lands on this pane's ⋯ trigger, else its active tab, else its "+N" chip, whichever is shown now.
 * Leaves focus alone when the pane lost ownership or something live already holds focus.
 */
export function focusStripActionsReturnTarget({
  actions,
  stillOwned
}: {
  actions: HTMLElement | null
  stillOwned: () => boolean
}): HTMLElement | null {
  if (!actions?.isConnected || !stillOwned()) {
    return null
  }
  const active = document.activeElement
  if (active && active !== document.body && active.isConnected) {
    return null
  }
  const strip = actions.closest<HTMLElement>('[data-tab-group-strip-id]')
  const candidates = [
    actions.querySelector('[data-pane-actions-menu-trigger]'),
    strip
      ?.querySelector('[data-tab-strip-slot]:has([data-active="true"])')
      ?.querySelector('[tabindex]'),
    strip?.querySelector('[data-tab-strip-overflow-chip]')
  ]
  for (const candidate of candidates) {
    if (isShown(candidate)) {
      candidate.focus()
      if (document.activeElement === candidate) {
        return candidate
      }
    }
  }
  return null
}
