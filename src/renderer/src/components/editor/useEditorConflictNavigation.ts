import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getNextConflictNavigationIndex } from './ConflictComponents'
import {
  findGitConflictBlocks,
  getGitConflictMarkerLineLength
} from './monaco-conflict-decorations'

export type EditorConflictNavigation = {
  currentIndex: number | null
  total: number
  onJump: (direction: 'previous' | 'next') => void
}

export function useEditorConflictNavigation(): (
  file: OpenFile,
  content: string
) => EditorConflictNavigation | undefined {
  const setPendingEditorReveal = useAppStore((state) => state.setPendingEditorReveal)
  const [navigationIndexByFile, setNavigationIndexByFile] = useState<Record<string, number>>({})

  return useCallback(
    (file: OpenFile, content: string) => {
      const blocks = findGitConflictBlocks(content)
      if (blocks.length === 0) {
        return undefined
      }

      const currentIndex = navigationIndexByFile[file.id] ?? null
      return {
        currentIndex,
        total: blocks.length,
        onJump: (direction: 'previous' | 'next') => {
          const nextIndex = getNextConflictNavigationIndex({
            currentIndex,
            direction,
            total: blocks.length
          })
          if (nextIndex === null) {
            return
          }
          const line = blocks[nextIndex].startLine
          const markerLineLength = getGitConflictMarkerLineLength(content, line)
          setNavigationIndexByFile((previous) => ({ ...previous, [file.id]: nextIndex }))
          // Why: clear first so a repeated same-location reveal still changes the prop and re-runs the editor's reveal effect.
          setPendingEditorReveal(null)
          queueMicrotask(() => {
            setPendingEditorReveal({
              filePath: file.filePath,
              line,
              column: 1,
              matchLength: markerLineLength
            })
          })
        }
      }
    },
    [navigationIndexByFile, setPendingEditorReveal]
  )
}
