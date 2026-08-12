import { useCallback, useMemo, useRef, useState } from 'react'

// Why: the same floors and ceilings a declared size is clamped to, so dragging
// cannot leave a track too small to click or larger than any viewport. Rows are
// bounded tighter than columns because a sheet has far more of them.
const COLUMN_BOUNDS = { minPx: 24, maxPx: 2000 }
const ROW_BOUNDS = { minPx: 12, maxPx: 400 }
// Why: one arrow press moves by a character or so, and holding shift moves by a
// visible step — a keyboard user should not need dozens of presses.
const KEYBOARD_STEP_PX = 8
const KEYBOARD_COARSE_STEP_PX = 48

export type SpreadsheetResizeBounds = { minPx: number; maxPx: number }

export type SpreadsheetResize = {
  /**
   * Sizes the reader has set, by track index, in unzoomed pixels. These win over
   * both the file's declared sizes and sizing from content.
   */
  widthOverrides: readonly (number | undefined)[]
  /** Starts a drag from a track's current rendered size. */
  startResize: (index: number, renderedSizePx: number) => void
  /** Applies a drag in progress, given the pointer's total travel. */
  updateResize: (deltaPx: number) => void
  endResize: () => void
  /** Nudges one track, for keyboard resizing. */
  nudgeResize: (index: number, renderedSizePx: number, deltaPx: number) => void
  /** Drops a reader's size so the track sizes itself again. */
  resetColumn: (index: number) => void
  /** Index of the track being dragged, or null. */
  resizingColumnIndex: number | null
}

/** @deprecated Prefer {@link SpreadsheetResize}; kept for existing call sites. */
export type SpreadsheetColumnResize = SpreadsheetResize

/**
 * Holds the track sizes a reader has dragged, along one axis.
 *
 * Sizes are kept unzoomed so that a track resized at one zoom level keeps its
 * proportion at every other, which is what a spreadsheet does when you zoom
 * after resizing.
 */
export function useSpreadsheetSizeResize(
  zoomScale: number,
  bounds: SpreadsheetResizeBounds
): SpreadsheetResize {
  const [widthOverrides, setWidthOverrides] = useState<readonly (number | undefined)[]>([])
  const [resizingColumnIndex, setResizingColumnIndex] = useState<number | null>(null)
  const dragRef = useRef<{ index: number; startSizePx: number } | null>(null)
  const safeZoomScale = zoomScale > 0 ? zoomScale : 1

  const setSize = useCallback(
    (index: number, sizePx: number): void => {
      setWidthOverrides((current) => {
        const next = [...current]
        next[index] = clampSize(sizePx, bounds)
        return next
      })
    },
    [bounds]
  )

  const startResize = useCallback(
    (index: number, renderedSizePx: number): void => {
      dragRef.current = { index, startSizePx: renderedSizePx / safeZoomScale }
      setResizingColumnIndex(index)
    },
    [safeZoomScale]
  )

  const updateResize = useCallback(
    (deltaPx: number): void => {
      const drag = dragRef.current
      if (drag === null) {
        return
      }
      setSize(drag.index, drag.startSizePx + deltaPx / safeZoomScale)
    },
    [safeZoomScale, setSize]
  )

  const endResize = useCallback((): void => {
    dragRef.current = null
    setResizingColumnIndex(null)
  }, [])

  const nudgeResize = useCallback(
    (index: number, renderedSizePx: number, deltaPx: number): void => {
      setSize(index, (renderedSizePx + deltaPx) / safeZoomScale)
    },
    [safeZoomScale, setSize]
  )

  const resetColumn = useCallback((index: number): void => {
    setWidthOverrides((current) => {
      if (current[index] === undefined) {
        return current
      }
      const next = [...current]
      next[index] = undefined
      return next
    })
  }, [])

  return useMemo(
    () => ({
      widthOverrides,
      startResize,
      updateResize,
      endResize,
      nudgeResize,
      resetColumn,
      resizingColumnIndex
    }),
    [
      widthOverrides,
      startResize,
      updateResize,
      endResize,
      nudgeResize,
      resetColumn,
      resizingColumnIndex
    ]
  )
}

/** Reader-set column widths. */
export function useSpreadsheetColumnResize(zoomScale: number): SpreadsheetResize {
  return useSpreadsheetSizeResize(zoomScale, COLUMN_BOUNDS)
}

/** Reader-set row heights. */
export function useSpreadsheetRowResize(zoomScale: number): SpreadsheetResize {
  return useSpreadsheetSizeResize(zoomScale, ROW_BOUNDS)
}

function clampSize(sizePx: number, bounds: SpreadsheetResizeBounds): number {
  if (!Number.isFinite(sizePx)) {
    return bounds.minPx
  }
  return Math.round(Math.min(bounds.maxPx, Math.max(bounds.minPx, sizePx)))
}

/**
 * Pixel step for an arrow key, growing the track towards the end of its axis.
 *
 * A column separator is a vertical bar sized with left and right; a row separator
 * is a horizontal one sized with up and down.
 */
export function resolveSpreadsheetResizeKeyStep(
  key: string,
  coarse: boolean,
  orientation: 'vertical' | 'horizontal' = 'vertical'
): number | null {
  const step = coarse ? KEYBOARD_COARSE_STEP_PX : KEYBOARD_STEP_PX
  const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
  const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
  if (key === grow) {
    return step
  }
  if (key === shrink) {
    return -step
  }
  return null
}
