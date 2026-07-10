import type { CSSProperties } from 'react'

type TerminalOverlayPaintStyle = Pick<
  CSSProperties,
  'display' | 'opacity' | 'pointerEvents' | 'visibility'
>

export function getTerminalOverlayPaintStyle(
  isVisible: boolean,
  shouldMeasureHiddenStartup: boolean
): TerminalOverlayPaintStyle {
  const shouldLayout = isVisible || shouldMeasureHiddenStartup

  return {
    display: shouldLayout ? 'flex' : 'none',
    opacity: isVisible ? 1 : 0,
    // Why: opacity alone can leak stale WebGL pixels from a measurable hidden xterm on Windows.
    visibility: isVisible ? 'visible' : 'hidden',
    pointerEvents: isVisible ? 'auto' : 'none'
  }
}
