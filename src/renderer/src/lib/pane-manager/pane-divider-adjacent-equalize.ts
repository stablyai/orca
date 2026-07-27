/** Flex used when a sash double-click equalizes the two adjacent panes. */
export const EQUALIZED_ADJACENT_PANE_FLEX = '1 1 0%'

/**
 * Equalize the two panes that share a terminal sash (VS Code-style double-click).
 * Preserves combined space by giving each side equal flex grow.
 * Returns false when either neighbor is missing (orphaned divider).
 */
export function equalizeAdjacentDividerPanes(
  previous: HTMLElement | null | undefined,
  next: HTMLElement | null | undefined
): boolean {
  if (!previous || !next) {
    return false
  }
  previous.style.flex = EQUALIZED_ADJACENT_PANE_FLEX
  next.style.flex = EQUALIZED_ADJACENT_PANE_FLEX
  return true
}

/** Native tooltip + a11y label for the sash hit target (#9644 discoverability). */
export const PANE_DIVIDER_EQUALIZE_HINT =
  'Drag to resize. Double-click to equalize the panes on either side.'
