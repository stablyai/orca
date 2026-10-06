/** Default equal flex when both sides already share weight 1 (or unparsable). */
export const EQUALIZED_ADJACENT_PANE_FLEX = '1 1 0%'

function parseFlexGrow(flex: string | undefined | null): number {
  if (!flex || !flex.trim()) {
    return 1
  }
  const first = flex.trim().split(/\s+/)[0]
  const n = Number.parseFloat(first)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * Equal flex for a sash pair that preserves their combined grow weight.
 * Why: `1 1 0%` on both would shrink a `3+1` pair from total 4 → 2 and expand third panes.
 */
export function equalizedAdjacentPaneFlex(
  previousFlex: string | undefined | null,
  nextFlex: string | undefined | null
): string {
  const total = parseFlexGrow(previousFlex) + parseFlexGrow(nextFlex)
  const half = total / 2
  if (half === 1) {
    return EQUALIZED_ADJACENT_PANE_FLEX
  }
  return `${half} 1 0%`
}

/**
 * Equalize the two panes that share a terminal sash (VS Code-style double-click).
 * Preserves combined space by giving each side half of the pair’s current flex grow.
 * Returns false when either neighbor is missing (orphaned divider).
 */
export function equalizeAdjacentDividerPanes(
  previous: HTMLElement | null | undefined,
  next: HTMLElement | null | undefined
): boolean {
  if (!previous || !next) {
    return false
  }
  const flex = equalizedAdjacentPaneFlex(previous.style.flex, next.style.flex)
  previous.style.flex = flex
  next.style.flex = flex
  return true
}

/** Native tooltip + a11y label for the sash hit target (#9644 discoverability). */
export const PANE_DIVIDER_EQUALIZE_HINT =
  'Drag to resize. Double-click to equalize the panes on either side.'
