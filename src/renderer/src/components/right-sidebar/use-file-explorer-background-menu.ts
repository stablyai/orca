import type React from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useState } from 'react'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/components/tab-bar/SortableTab'
import type { InlineInput } from './file-explorer-inline-input-row'

type UseFileExplorerBackgroundMenuResult = {
  bgMenuOpen: boolean
  setBgMenuOpen: Dispatch<SetStateAction<boolean>>
  bgMenuPoint: { x: number; y: number }
  handleExplorerBackgroundContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  handleExplorerBackgroundDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void
}

/** Empty-space interactions of the explorer surface: background menu and new-file double click. */
export function useFileExplorerBackgroundMenu({
  worktreePath,
  inlineInput,
  startNew
}: {
  worktreePath: string | null
  inlineInput: InlineInput | null
  startNew: (type: 'file' | 'folder', parentPath: string, depth: number) => void
}): UseFileExplorerBackgroundMenuResult {
  const [bgMenuOpen, setBgMenuOpen] = useState(false)
  const [bgMenuPoint, setBgMenuPoint] = useState({ x: 0, y: 0 })

  const handleExplorerBackgroundContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-slot="context-menu-trigger"]')) {
        return
      }
      event.preventDefault()
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
      setBgMenuPoint({ x: event.clientX, y: event.clientY })
      setBgMenuOpen(true)
    },
    []
  )

  const handleExplorerBackgroundDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!worktreePath || inlineInput) {
        return
      }
      const target = event.target as HTMLElement
      if (target.closest('[data-slot="context-menu-trigger"]')) {
        return
      }
      startNew('file', worktreePath, 0)
    },
    [inlineInput, startNew, worktreePath]
  )

  return {
    bgMenuOpen,
    setBgMenuOpen,
    bgMenuPoint,
    handleExplorerBackgroundContextMenuCapture,
    handleExplorerBackgroundDoubleClick
  }
}
