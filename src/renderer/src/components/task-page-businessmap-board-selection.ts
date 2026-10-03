import { useMemo } from 'react'
import type { BusinessmapBoard } from '../../../shared/businessmap-types'

export function useTaskPageBusinessmapBoardSelection(boards: readonly BusinessmapBoard[]) {
  return useMemo(() => [...boards].sort((a, b) => a.name.localeCompare(b.name)), [boards])
}

export function getBusinessmapBoardSelectionKey(board: BusinessmapBoard): string {
  return String(board.id)
}
