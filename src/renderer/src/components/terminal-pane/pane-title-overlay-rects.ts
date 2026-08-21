/**
 * Pane-title overlay rect state transitions for TerminalPane.
 *
 * Why: both helpers exist to hand React a referentially-equal value when
 * nothing changed, so a measurement pass cannot commit a redundant render
 * (React #185 amplification). Extracted so that identity contract is testable.
 */
import type { PaneTitleOverlayRect } from './TerminalPaneHeaderOverlay'

export function arePaneTitleOverlayRectsEqual(
  a: Record<number, PaneTitleOverlayRect>,
  b: Record<number, PaneTitleOverlayRect>
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every((key) => {
    const paneId = Number(key)
    const left = Math.abs((a[paneId]?.left ?? 0) - (b[paneId]?.left ?? 0))
    const top = Math.abs((a[paneId]?.top ?? 0) - (b[paneId]?.top ?? 0))
    const width = Math.abs((a[paneId]?.width ?? 0) - (b[paneId]?.width ?? 0))
    return left < 0.5 && top < 0.5 && width < 0.5
  })
}

/** Returns `prev` untouched when already empty — never a fresh {} literal. */
export function clearPaneTitleOverlayRects(
  prev: Record<number, PaneTitleOverlayRect>
): Record<number, PaneTitleOverlayRect> {
  return Object.keys(prev).length === 0 ? prev : {}
}
