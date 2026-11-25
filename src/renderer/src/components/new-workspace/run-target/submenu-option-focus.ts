/** Moves focus one enabled option up or down a submenu list, stopping at its ends. */
export function stepSubmenuOptionFocus(list: HTMLElement, delta: 1 | -1): void {
  const items = [
    ...list.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])')
  ]
  if (items.length === 0) {
    return
  }
  const active = document.activeElement
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1
  const next = current === -1 ? (delta === 1 ? 0 : items.length - 1) : current + delta
  items[Math.max(0, Math.min(items.length - 1, next))]?.focus()
}

/** Focuses a submenu list's first enabled option; false when it has none yet (still loading). */
export function focusFirstSubmenuOption(list: HTMLElement | null): boolean {
  const first = list?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')
  first?.focus()
  return Boolean(first)
}

/** Focuses the first enabled option once a portaled list has mounted, trying for a few frames. */
export function focusFirstSubmenuOptionWhenMounted(list: () => HTMLElement | null): () => void {
  let frame = 0
  let tries = 0
  const attempt = (): void => {
    if (!focusFirstSubmenuOption(list()) && tries++ < 10) {
      frame = requestAnimationFrame(attempt)
    }
  }
  attempt()
  return () => cancelAnimationFrame(frame)
}
