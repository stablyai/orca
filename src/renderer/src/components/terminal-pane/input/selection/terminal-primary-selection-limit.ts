import type { Terminal } from '@xterm/xterm'
import { PRIMARY_SELECTION_MAX_LENGTH } from '@/lib/clipboard/primary-selection/primary-selection'

export function terminalSelectionExceedsPrimaryLimit(terminal: Terminal): boolean {
  const range = terminal.getSelectionPosition()
  if (!range) {
    return false
  }
  const startY = Math.min(range.start.y, range.end.y)
  const endY = Math.max(range.start.y, range.end.y)
  const rowSpan = endY - startY
  const cellEstimate =
    rowSpan === 0
      ? Math.abs(range.end.x - range.start.x)
      : rowSpan * terminal.cols + Math.abs(range.end.x - range.start.x)
  return cellEstimate > PRIMARY_SELECTION_MAX_LENGTH
}
