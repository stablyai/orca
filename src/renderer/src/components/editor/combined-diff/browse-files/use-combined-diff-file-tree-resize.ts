import React, { useCallback, useEffect, useState } from 'react'
import {
  clampCombinedDiffFileTreeWidth,
  COMBINED_DIFF_FILE_TREE_RESIZE_STEP,
  computeCombinedDiffFileTreeWidthBounds
} from '../../../../../../shared/combined-diff-file-tree-width'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useAppStore } from '@/store'

export function useCombinedDiffFileTreeResize(collapsed: boolean): {
  handleResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  handleResizeStart: (event: React.MouseEvent) => void
  maxWidth: number
  minWidth: number
  treeRef: React.RefObject<HTMLElement | null>
  width: number
} {
  const storedWidth = useAppStore((s) => s.combinedDiffFileTreeWidth)
  const setStoredWidth = useAppStore((s) => s.setCombinedDiffFileTreeWidth)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const { maxWidth, minWidth } = computeCombinedDiffFileTreeWidthBounds(containerWidth ?? 0)
  // Clamp only rendered width; hidden or narrowed panes must not overwrite the user’s stored choice.
  const width = clampCombinedDiffFileTreeWidth(storedWidth, containerWidth ?? undefined)
  const { containerRef, onResizeStart } = useSidebarResize<HTMLElement>({
    // The hook survives collapsed tree unmounts; isOpen must invalidate width application on reopening.
    isOpen: !collapsed,
    width,
    minWidth,
    maxWidth,
    deltaSign: 1,
    setWidth: setStoredWidth
  })

  useEffect(() => {
    const container = containerRef.current?.parentElement
    if (collapsed || !container) {
      return
    }
    // clientWidth ignores ancestor transforms, including dialog opening animations.
    const measure = (): void => {
      setContainerWidth(container.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [collapsed, containerRef])

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const step = COMBINED_DIFF_FILE_TREE_RESIZE_STEP * (event.shiftKey ? 2 : 1)
      setStoredWidth(
        clampCombinedDiffFileTreeWidth(width + direction * step, containerWidth ?? undefined)
      )
    },
    [containerWidth, setStoredWidth, width]
  )

  return {
    handleResizeKeyDown,
    handleResizeStart: onResizeStart,
    maxWidth,
    minWidth,
    treeRef: containerRef,
    width
  }
}
