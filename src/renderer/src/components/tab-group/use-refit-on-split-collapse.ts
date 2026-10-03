import { useLayoutEffect, useRef } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/types'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { countLayoutLeaves } from './tab-group-layout-leaf-count'

export function useRefitOnSplitCollapse(
  layout: TabGroupLayoutNode,
  isWorktreeActive: boolean
): void {
  const prevLeafCountRef = useRef(countLayoutLeaves(layout))
  useLayoutEffect(() => {
    const leafCount = countLayoutLeaves(layout)
    const collapsed = leafCount < prevLeafCountRef.current
    prevLeafCountRef.current = leafCount
    if (!isWorktreeActive || !collapsed) {
      return
    }
    // Why: a split collapse changes width via React/flex layout, not the
    // terminal's pane tree; fitting in layout effect keeps the survivor in sync
    // before the old narrow grid can paint.
    window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
  }, [layout, isWorktreeActive])
}
