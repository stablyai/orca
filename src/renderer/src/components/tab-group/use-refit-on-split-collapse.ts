import { useEffect, useRef } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { countLayoutLeaves } from './tab-group-layout-leaf-count'

/**
 * Forces a synchronous fit of all visible terminal panes when a tab-group split
 * collapses (the layout tree loses a leaf), so the surviving group's xterm grid
 * reflows to the new, wider container.
 *
 * Why: a collapsing split widens the surviving group via flexbox alone. The
 * within-tab pane close has a deterministic rAF refit (onLayoutChanged →
 * queueResizeAll → fitPanes); the group path otherwise relies only on a
 * 150ms-debounced ResizeObserver that can miss the flex-only resize, leaving an
 * idle agent's xterm pinned at the old narrow width with a blank survivor half
 * (#6154). Double-rAF: the first frame commits React/flex styles, the second
 * runs after layout reflow so proposeDimensions reads the new width. Only fires
 * on a leaf-count *decrease* so splits/ratio drags (which have their own fit
 * paths) don't trigger it, and only while the worktree is visible (the
 * SYNC_FIT_PANES_EVENT listener and safeFit skip unmeasurable hidden panes).
 */
export function useRefitOnSplitCollapse(
  layout: TabGroupLayoutNode,
  isWorktreeActive: boolean
): void {
  const prevLeafCountRef = useRef(countLayoutLeaves(layout))
  useEffect(() => {
    const leafCount = countLayoutLeaves(layout)
    const collapsed = leafCount < prevLeafCountRef.current
    prevLeafCountRef.current = leafCount
    if (!isWorktreeActive || !collapsed) {
      return
    }
    const handles = { raf1: 0, raf2: 0 }
    handles.raf1 = requestAnimationFrame(() => {
      handles.raf2 = requestAnimationFrame(() => {
        window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
      })
    })
    return () => {
      cancelAnimationFrame(handles.raf1)
      if (handles.raf2) {
        cancelAnimationFrame(handles.raf2)
      }
    }
  }, [layout, isWorktreeActive])
}
