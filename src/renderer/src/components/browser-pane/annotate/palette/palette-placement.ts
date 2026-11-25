/** Pure placement math for the annotate palette; both axes share it. */
import type { CSSProperties } from 'react'
import type { AnnotatePalettePosition } from './annotate-palette-position-store'

/** Where the palette sits, and the sizes and inputs that placement was derived for. */
export type PaletteLayout = {
  boundsWidth: number
  boundsHeight: number
  paletteWidth: number
  paletteHeight: number
  left: number
  top: number
  /** The saved position and top limit this layout was derived for. */
  x: number
  y: number
  topMin: number
}

export function samePaletteLayout(a: PaletteLayout, b: PaletteLayout): boolean {
  return (
    a.boundsWidth === b.boundsWidth &&
    a.boundsHeight === b.boundsHeight &&
    a.paletteWidth === b.paletteWidth &&
    a.paletteHeight === b.paletteHeight &&
    a.left === b.left &&
    a.top === b.top &&
    a.x === b.x &&
    a.y === b.y &&
    a.topMin === b.topMin
  )
}

/** Gap kept between the palette and every edge of the page. */
export const PALETTE_EDGE_INSET_PX = 8
const KEY_STEP = 0.05
const KEY_STEP_LARGE = 0.25
const HINT_GAP_PX = 8
/** The one-line hint plus its gaps. */
const HINT_ROOM_PX = 40
/** Releasing this close to the horizontal centre (as a fraction of travel) snaps back to centre. */
const PALETTE_CENTRE_SNAP = 0.04

/**
 * Offset in px along one axis for a 0–1 fraction of the free travel.
 * Both axes measure travel inset from both edges, so a saved fraction means the same spot in any pane size.
 * Travel starts at `min`: under an open find bar 0 is just below it, so the top stays the top when find closes.
 */
export function paletteOffsetForRatio(
  ratio: number,
  boundsSize: number,
  paletteSize: number,
  min: number = PALETTE_EDGE_INSET_PX
): number {
  const travel = Math.max(0, boundsSize - paletteSize - PALETTE_EDGE_INSET_PX - min)
  return min + travel * Math.min(1, Math.max(0, ratio))
}

/** Inverse of paletteOffsetForRatio; with no travel the fraction is meaningless, so keep `fallback`. */
export function paletteRatioForOffset(
  offset: number,
  boundsSize: number,
  paletteSize: number,
  fallback: number,
  min: number = PALETTE_EDGE_INSET_PX
): number {
  const travel = boundsSize - paletteSize - PALETTE_EDGE_INSET_PX - min
  if (travel <= 0) {
    return fallback
  }
  return Math.min(1, Math.max(0, (offset - min) / travel))
}

/** Fractions the palette shows at now; the vertical one counts from the current top limit. */
export function paletteShownPosition(layout: PaletteLayout): AnnotatePalettePosition {
  return {
    x: paletteRatioForOffset(layout.left, layout.boundsWidth, layout.paletteWidth, 0.5),
    y: paletteRatioForOffset(
      layout.top,
      layout.boundsHeight,
      layout.paletteHeight,
      0,
      layout.topMin
    )
  }
}

/**
 * Keeps the palette inside the bounds along one axis, never above `min` (the find bar can raise the top one).
 * A palette larger than its bounds pins to `min`.
 */
export function clampPaletteOffset(
  offset: number,
  boundsSize: number,
  paletteSize: number,
  min: number = PALETTE_EDGE_INSET_PX
): number {
  const max = Math.max(min, boundsSize - paletteSize - PALETTE_EDGE_INSET_PX)
  return Math.min(max, Math.max(min, offset))
}

export function snapPaletteRatio(ratio: number): number {
  return Math.abs(ratio - 0.5) < PALETTE_CENTRE_SNAP ? 0.5 : ratio
}

/** Screen-reader value for one axis of the grip. */
export function paletteRatioPercent(ratio: number): number {
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100)
}

/**
 * The hint sits under the palette, or above it near the page's bottom where there's no room under it.
 * Measured height: at the last fit level a row can wrap and make the palette taller than one line.
 */
export function paletteHintPlacement(layout: PaletteLayout): CSSProperties {
  const { left, top, paletteHeight } = layout
  return layout.boundsHeight - top - paletteHeight < HINT_ROOM_PX
    ? { left, bottom: `calc(100% - ${top - HINT_GAP_PX}px)` }
    : { left, top: top + paletteHeight + HINT_GAP_PX }
}

/** Re-places the palette at its saved position; `axis` limits it to the one a grip key moved. */
export function paletteReanchor(
  layout: PaletteLayout,
  saved: AnnotatePalettePosition,
  topMin: number,
  axis?: 'x' | 'y'
): PaletteLayout {
  const { boundsWidth, boundsHeight, paletteWidth, paletteHeight } = layout
  return {
    ...layout,
    left: axis === 'y' ? layout.left : paletteOffsetForRatio(saved.x, boundsWidth, paletteWidth),
    top:
      axis === 'x'
        ? layout.top
        : clampPaletteOffset(
            paletteOffsetForRatio(saved.y, boundsHeight, paletteHeight, topMin),
            boundsHeight,
            paletteHeight,
            topMin
          ),
    topMin
  }
}

/** The sizes a drag was measured against, where it started, and the saved position it started from. */
export type PaletteDragStart = {
  boundsWidth: number
  boundsHeight: number
  paletteWidth: number
  paletteHeight: number
  left: number
  top: number
  topMin: number
  saved: AnnotatePalettePosition
}

/**
 * Where a drag comes to rest and what it saves. `released` is null for a cancelled drag. Only an axis the drag
 * actually moved is written: an unmoved one keeps its saved fraction (reading it back from an anchored or pinned
 * edge would drift it), so a press that never moved saves nothing.
 */
export function paletteDragRest(
  start: PaletteDragStart,
  released: { left: number; top: number } | null,
  topMin: number
): { left: number; top: number; save: AnnotatePalettePosition | null; snapped: boolean } {
  const { boundsWidth, boundsHeight, paletteWidth, paletteHeight, saved } = start
  const releasedLeft = released && released.left !== start.left ? released.left : null
  const releasedTop = released && released.top !== start.top ? released.top : null
  const rawX =
    releasedLeft === null
      ? saved.x
      : paletteRatioForOffset(releasedLeft, boundsWidth, paletteWidth, saved.x)
  const x = releasedLeft === null ? saved.x : snapPaletteRatio(rawX)
  const left =
    releasedLeft === null
      ? start.left
      : x === rawX
        ? releasedLeft
        : paletteOffsetForRatio(x, boundsWidth, paletteWidth)
  // An unmoved top stays put, unless a find bar opened or closed meanwhile: then the saved height goes against the
  // new limit.
  const top =
    releasedTop !== null
      ? clampPaletteOffset(releasedTop, boundsHeight, paletteHeight, topMin)
      : topMin === start.topMin
        ? start.top
        : clampPaletteOffset(
            paletteOffsetForRatio(saved.y, boundsHeight, paletteHeight, topMin),
            boundsHeight,
            paletteHeight,
            topMin
          )
  const y =
    releasedTop === null
      ? saved.y
      : paletteRatioForOffset(top, boundsHeight, paletteHeight, saved.y, topMin)
  const moved = releasedLeft !== null || releasedTop !== null
  return { left, top, save: moved ? { x, y } : null, snapped: x !== rawX }
}

/**
 * Where a grip key moves the palette: the moved axis steps from where it shows now, the other keeps its saved
 * value (a find bar can push the shown top below the saved one; a sideways key must not save that). Null for keys
 * that don't move it that way.
 */
export function paletteKeyMove(
  key: string,
  large: boolean,
  shown: AnnotatePalettePosition,
  saved: AnnotatePalettePosition,
  canMoveX: boolean,
  canMoveY: boolean
): AnnotatePalettePosition | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP
  if (canMoveX && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return { x: key === 'ArrowLeft' ? shown.x - step : shown.x + step, y: saved.y }
  }
  if (canMoveY && (key === 'ArrowUp' || key === 'ArrowDown')) {
    return { x: saved.x, y: key === 'ArrowUp' ? shown.y - step : shown.y + step }
  }
  if (canMoveX && (key === 'Home' || key === 'End')) {
    return { x: key === 'Home' ? 0 : 1, y: saved.y }
  }
  return null
}
