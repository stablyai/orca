import { useCallback, useMemo, useRef, useState } from 'react'

// Why: the same floor and ceiling a declared width is clamped to, so dragging
// cannot leave a column too narrow to click or wider than any viewport.
const MIN_RESIZED_COLUMN_PX = 24
const MAX_RESIZED_COLUMN_PX = 2000
// Why: one arrow press moves by a character or so, and holding shift moves by a
// visible step — a keyboard user should not need dozens of presses.
const KEYBOARD_STEP_PX = 8
const KEYBOARD_COARSE_STEP_PX = 48

export type SpreadsheetColumnResize = {
  /**
   * Widths the reader has set, by column index, in unzoomed pixels. These win
   * over both the file's declared widths and sizing from content.
   */
  widthOverrides: readonly (number | undefined)[]
  /** Starts a drag from a column's current rendered width. */
  startResize: (columnIndex: number, renderedWidthPx: number) => void
  /** Applies a drag in progress, given the pointer's total travel. */
  updateResize: (deltaPx: number) => void
  endResize: () => void
  /** Nudges one column, for keyboard resizing. */
  nudgeResize: (columnIndex: number, renderedWidthPx: number, deltaPx: number) => void
  /** Drops a reader's width so the column sizes itself again. */
  resetColumn: (columnIndex: number) => void
  /** Index of the column being dragged, or null. */
  resizingColumnIndex: number | null
}

/**
 * Holds the column widths a reader has dragged.
 *
 * Widths are kept unzoomed so that a column resized at one zoom level keeps its
 * proportion at every other, which is what a spreadsheet does when you zoom
 * after resizing.
 */
export function useSpreadsheetColumnResize(zoomScale: number): SpreadsheetColumnResize {
  const [widthOverrides, setWidthOverrides] = useState<readonly (number | undefined)[]>([])
  const [resizingColumnIndex, setResizingColumnIndex] = useState<number | null>(null)
  const dragRef = useRef<{ columnIndex: number; startWidthPx: number } | null>(null)
  const safeZoomScale = zoomScale > 0 ? zoomScale : 1

  const setColumnWidth = useCallback((columnIndex: number, widthPx: number): void => {
    setWidthOverrides((current) => {
      const next = [...current]
      next[columnIndex] = clampColumnWidth(widthPx)
      return next
    })
  }, [])

  const startResize = useCallback(
    (columnIndex: number, renderedWidthPx: number): void => {
      dragRef.current = { columnIndex, startWidthPx: renderedWidthPx / safeZoomScale }
      setResizingColumnIndex(columnIndex)
    },
    [safeZoomScale]
  )

  const updateResize = useCallback(
    (deltaPx: number): void => {
      const drag = dragRef.current
      if (drag === null) {
        return
      }
      setColumnWidth(drag.columnIndex, drag.startWidthPx + deltaPx / safeZoomScale)
    },
    [safeZoomScale, setColumnWidth]
  )

  const endResize = useCallback((): void => {
    dragRef.current = null
    setResizingColumnIndex(null)
  }, [])

  const nudgeResize = useCallback(
    (columnIndex: number, renderedWidthPx: number, deltaPx: number): void => {
      setColumnWidth(columnIndex, (renderedWidthPx + deltaPx) / safeZoomScale)
    },
    [safeZoomScale, setColumnWidth]
  )

  const resetColumn = useCallback((columnIndex: number): void => {
    setWidthOverrides((current) => {
      if (current[columnIndex] === undefined) {
        return current
      }
      const next = [...current]
      next[columnIndex] = undefined
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

function clampColumnWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) {
    return MIN_RESIZED_COLUMN_PX
  }
  return Math.round(Math.min(MAX_RESIZED_COLUMN_PX, Math.max(MIN_RESIZED_COLUMN_PX, widthPx)))
}

/** Pixel step for an arrow key, widening on the right and narrowing on the left. */
export function resolveSpreadsheetResizeKeyStep(key: string, coarse: boolean): number | null {
  const step = coarse ? KEYBOARD_COARSE_STEP_PX : KEYBOARD_STEP_PX
  if (key === 'ArrowRight') {
    return step
  }
  if (key === 'ArrowLeft') {
    return -step
  }
  return null
}
