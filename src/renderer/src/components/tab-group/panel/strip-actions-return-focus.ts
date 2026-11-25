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
 * Lands on this pane's ⋯ trigger, else its active tab, whichever is shown now.
 * Leaves focus alone when the pane lost ownership or something live already holds focus.
 */
export function focusStripActionsReturnTarget({
  trigger,
  stillOwned
}: {
  trigger: HTMLElement | null
  stillOwned: () => boolean
}): HTMLElement | null {
  if (!trigger?.isConnected || !stillOwned()) {
    return null
  }
  const active = document.activeElement
  if (active && active !== document.body && active.isConnected) {
    return null
  }
  const strip = trigger.closest<HTMLElement>('[data-tab-group-strip-id]')
  const candidates = [
    trigger,
    strip
      ?.querySelector('[data-tab-strip-slot]:has([data-active="true"])')
      ?.querySelector('[tabindex]')
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
