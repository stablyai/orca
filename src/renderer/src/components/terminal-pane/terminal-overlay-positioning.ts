const HAS_CSS_ANCHOR_POSITIONING =
  typeof CSS !== 'undefined' &&
  CSS.supports('position-anchor', '--orca-terminal-overlay-probe') &&
  CSS.supports('top', 'anchor(--orca-terminal-overlay-probe top)') &&
  CSS.supports('width', 'anchor-size(--orca-terminal-overlay-probe width)')

export const MIN_OVERLAY_FIT_WIDTH_PX = 48
export const MIN_OVERLAY_FIT_HEIGHT_PX = 24
export const FALLBACK_RECT_MIN_CHANGE_PX = 1

export function shouldUseCssAnchorPositioning(): boolean {
  return (
    HAS_CSS_ANCHOR_POSITIONING &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}
