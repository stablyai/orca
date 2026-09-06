import type { SessionGridLayoutPreset } from '../../../../shared/session-grid-types'

// Vertical rhythm of the grid: outer padding and the gap between rows, in px.
export const SESSION_GRID_PADDING_PX = 12
export const SESSION_GRID_ROW_GAP_PX = 12
const MIN_ROW_HEIGHT_PX = 200

export function computeGridDimensions(
  preset: SessionGridLayoutPreset,
  itemCount: number
): { cols: number; rowsPerView: number } {
  switch (preset) {
    case '1x2':
      return { cols: 1, rowsPerView: 2 }
    case '2x1':
      return { cols: 2, rowsPerView: 1 }
    case '2x2':
      return { cols: 2, rowsPerView: 2 }
    case '3x2':
      return { cols: 3, rowsPerView: 2 }
    case '3x3':
      return { cols: 3, rowsPerView: 3 }
    case 'auto': {
      if (itemCount <= 1) {
        return { cols: 1, rowsPerView: 1 }
      }
      if (itemCount === 2) {
        return { cols: 2, rowsPerView: 1 }
      }
      if (itemCount <= 4) {
        return { cols: 2, rowsPerView: 2 }
      }
      return { cols: 3, rowsPerView: 2 }
    }
  }
}

/** Pixel row height that locks `rowsPerView` rows to the measured viewport. */
export function computeSessionGridRowHeight(containerHeight: number, rowsPerView: number): number {
  const baseHeight = containerHeight > 0 ? containerHeight : 800
  const available = Math.max(
    MIN_ROW_HEIGHT_PX,
    baseHeight - 2 * SESSION_GRID_PADDING_PX - (rowsPerView - 1) * SESSION_GRID_ROW_GAP_PX
  )
  return Math.round(available / rowsPerView)
}

export type SessionGridSlotCounts = {
  totalSlotCount: number
  totalRowCount: number
  totalPageCount: number
}

/**
 * How many slots the grid lays out. With empty slots on, the items are padded
 * to the end of their row and a whole extra row is added — never fewer than
 * one full screen — so there is always somewhere to launch a session without
 * changing preset. Both scroll modes derive their counts from this.
 */
export function computeSessionGridSlotCounts(args: {
  itemCount: number
  cols: number
  rowsPerView: number
  showEmpty: boolean
}): SessionGridSlotCounts {
  const { itemCount, cols, rowsPerView, showEmpty } = args
  const itemsPerPage = cols * rowsPerView
  const paddedToRowEnd = Math.ceil(itemCount / cols) * cols
  const totalSlotCount = showEmpty ? Math.max(itemsPerPage, paddedToRowEnd + cols) : itemCount
  return {
    totalSlotCount,
    totalRowCount: Math.max(1, Math.ceil(totalSlotCount / cols)),
    totalPageCount: Math.max(1, Math.ceil(totalSlotCount / itemsPerPage))
  }
}
