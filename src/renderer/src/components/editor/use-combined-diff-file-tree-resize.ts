import React, { useCallback, useEffect, useState } from 'react'
import {
  clampCombinedDiffFileTreeWidth,
  COMBINED_DIFF_FILE_TREE_RESIZE_STEP,
  computeCombinedDiffFileTreeWidthBounds
} from '../../../../shared/combined-diff-file-tree-width'
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
  // Why: the container clamp is render-only — a pane that is hidden (0px) or temporarily
  // narrowed must never write back and shrink the width the user chose.
  const width = clampCombinedDiffFileTreeWidth(storedWidth, containerWidth ?? undefined)
  const { containerRef, onResizeStart } = useSidebarResize<HTMLElement>({
    // Why: the tree unmounts while collapsed but this hook does not, so the toggle has to
    // invalidate useSidebarResize's layout effect or the re-expanded aside keeps no width.
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
    // Why: clientWidth ignores ancestor transforms, so a dialog's open animation can't mis-measure.
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
