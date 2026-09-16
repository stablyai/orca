import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { DirCache } from './file-explorer-types'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'
import { useFileExplorerReveal } from './useFileExplorerReveal'

type UseFileExplorerRowScrollingParams = {
  visibleRowCount: number
  inlineInputIndex: number
  rowProjection: FileExplorerRowProjection
  scrollRef: RefObject<HTMLDivElement | null>
  activeWorktreeId: string | null
  worktreePath: string | null
  expanded: Set<string>
  dirCache: Record<string, DirCache>
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  loadDir: (dirPath: string, depth: number, options?: { force?: boolean }) => Promise<boolean>
  setSelectedPath: (path: string | null) => void
  activeFileId: string | null
  openFiles: OpenFile[]
}

type UseFileExplorerRowScrollingResult = {
  virtualizer: Virtualizer<HTMLDivElement, Element>
  scrollToIndex: (index: number) => void
  flashingPath: string | null
  explorerShellRef: RefObject<HTMLDivElement | null>
  setExplorerShellRef: (node: HTMLDivElement | null) => void
}

/** Decides which explorer row is measured and scrolled into view. */
export function useFileExplorerRowScrolling({
  visibleRowCount,
  inlineInputIndex,
  rowProjection,
  scrollRef,
  activeWorktreeId,
  worktreePath,
  expanded,
  dirCache,
  loadingDirPaths,
  rootCache,
  loadDir,
  setSelectedPath,
  activeFileId,
  openFiles
}: UseFileExplorerRowScrollingParams): UseFileExplorerRowScrollingResult {
  const pendingExplorerReveal = useAppStore((s) => s.pendingExplorerReveal)
  const clearPendingExplorerReveal = useAppStore((s) => s.clearPendingExplorerReveal)
  const [flashingPath, setFlashingPath] = useState<string | null>(null)
  /** Includes Radix scroll viewport + scrollbar (scrollbar is not a child of the viewport). */
  const explorerShellRef = useRef<HTMLDivElement | null>(null)
  const flashTimeoutRef = useRef<number | null>(null)

  const totalCount = visibleRowCount + (inlineInputIndex >= 0 ? 1 : 0)

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 20,
    getItemKey: (index) => {
      if (inlineInputIndex >= 0) {
        if (index === inlineInputIndex) {
          return '__inline_input__'
        }
        const rowIndex = index > inlineInputIndex ? index - 1 : index
        return rowProjection.getRowAtIndex(rowIndex)?.path ?? `__fallback_${index}`
      }
      return rowProjection.getRowAtIndex(index)?.path ?? `__fallback_${index}`
    }
  })

  const cancelRevealTimers = useFileExplorerReveal({
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    clearPendingExplorerReveal,
    expanded,
    dirCache,
    loadingDirPaths,
    rootCache,
    rowProjection,
    loadDir,
    setSelectedPath,
    setFlashingPath,
    flashTimeoutRef,
    virtualizer
  })
  const setExplorerShellRef = useCallback(
    (node: HTMLDivElement | null): void => {
      explorerShellRef.current = node
      if (node !== null) {
        return
      }
      // Why: reveal flash/scroll timers target the explorer shell; clear them
      // when that owner detaches instead of keeping a passive unmount Effect.
      cancelRevealTimers()
    },
    [cancelRevealTimers]
  )

  useFileExplorerAutoReveal({
    activeFileId,
    activeWorktreeId,
    worktreePath,
    pendingExplorerReveal,
    openFiles,
    rowProjection,
    setSelectedPath,
    virtualizer
  })

  useEffect(() => {
    if (inlineInputIndex >= 0) {
      virtualizer.scrollToIndex(inlineInputIndex, { align: 'auto' })
    }
  }, [inlineInputIndex, virtualizer])

  const scrollToIndex = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    },
    [virtualizer]
  )

  return { virtualizer, scrollToIndex, flashingPath, explorerShellRef, setExplorerShellRef }
}
