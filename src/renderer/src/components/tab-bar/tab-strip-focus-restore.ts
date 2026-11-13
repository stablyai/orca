function isShown(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element && element.isConnected && element.offsetParent !== null)
}

/** Remember where focus is when a menu closes, so a deferred restore can tell if the user moved it. */
export function captureFocusBeforeRestore(): Element | null {
  return document.activeElement
}

/**
 * Deferred focus after a strip menu closes: the slot's tab root, else this strip's "+N" chip (the
 * chip-only state has no slot). Rechecked at execution so it never steals focus: the strip must
 * still be connected and owned, the target shown inside it, and focus not moved meanwhile.
 */
export function restoreTabStripFocus({
  strip,
  slotId,
  stillOwned,
  focusBefore
}: {
  strip: HTMLElement | null
  slotId: string | null
  stillOwned: () => boolean
  focusBefore: Element | null
}): void {
  if (!isShown(strip) || !stillOwned()) {
    return
  }
  const active = document.activeElement
  const focusMoved =
    active !== null &&
    active !== document.body &&
    active !== focusBefore &&
    // A closing menu's own items are being removed; that is not a user focus change.
    active.closest('[data-slot="dropdown-menu-content"]') === null
  if (focusMoved) {
    return
  }
  const slot =
    slotId === null
      ? null
      : strip.querySelector<HTMLElement>(`[data-tab-strip-slot="${CSS.escape(slotId)}"]`)
  const slotTarget = slot?.querySelector<HTMLElement>('[tabindex]') ?? slot
  const target = isShown(slotTarget)
    ? slotTarget
    : strip.querySelector<HTMLElement>('[data-tab-strip-overflow-chip]')
  if (isShown(target)) {
    target.focus()
  }
}
