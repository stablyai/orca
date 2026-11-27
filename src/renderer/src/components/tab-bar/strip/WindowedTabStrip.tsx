import React, { useLayoutEffect, useMemo, useState, type RefObject } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { sameStringArray } from '@/runtime/web-session-tabs-sync/snapshots/state-equality-core'
import { useActiveDragVisibleTabId } from '../../tab-group/drag/tab-drag-context'
import { findTabStripSlot } from './tab-strip-slot-geometry'
import {
  buildTabStripSegments,
  useTabStripWindowState,
  type TabStripSegment
} from './tab-strip-window'

/** Owns the strip's window state, so scrolling re-renders the strip alone, not the tab bar around it. */
export function WindowedTabStrip({
  stripRef,
  wrapTabs = false,
  subscribeToStripResize,
  sortableIds,
  activeVisibleTabId,
  renderStrip
}: {
  stripRef: RefObject<HTMLDivElement | null>
  wrapTabs?: boolean
  subscribeToStripResize: (listener: () => void) => () => void
  sortableIds: string[]
  activeVisibleTabId: string | null
  /** Renders the scroller (which must attach `stripRef`) with these mounted runs of the tabs. */
  renderStrip: (segments: readonly TabStripSegment[], columns: number | null) => React.ReactNode
}): React.JSX.Element {
  const count = sortableIds.length
  const windowState = useTabStripWindowState(stripRef, count, subscribeToStripResize, wrapTabs)
  const { focusedSlotId } = windowState
  const columns = wrapTabs ? (windowState.columns ?? 1) : null
  const range = (windowState.columns !== null) === wrapTabs ? windowState.range : null
  const activeDragVisibleTabId = useActiveDragVisibleTabId()
  const windowed = range !== null
  // Why keyed on sortableIds: they change only when tabs open, close or move, not on every tab write.
  const indexBySortableId = useMemo(
    () => (windowed ? new Map(sortableIds.map((id, index) => [id, index])) : null),
    [sortableIds, windowed]
  )
  const tabStripWindow = useMemo(() => {
    if (range === null || indexBySortableId === null) {
      return { segments: buildTabStripSegments(count, null, []), sortableIds }
    }
    // Keep the active, dragged and focused tabs mounted wherever they sit in the order.
    const keptIndices = [activeVisibleTabId, activeDragVisibleTabId, focusedSlotId].flatMap(
      (id) => {
        const index = id === null ? undefined : indexBySortableId.get(id)
        return index === undefined ? [] : [index]
      }
    )
    if (columns !== null) {
      // Client-hosted browser tabs can share the final row with sortable tabs.
      keptIndices.push(count - 1)
    }
    const segments = buildTabStripSegments(count, range, keptIndices, columns ?? 1)
    const mountedIds = segments.flatMap((segment) =>
      segment.kind === 'tabs' ? sortableIds.slice(segment.start, segment.end) : []
    )
    return { segments, sortableIds: mountedIds }
  }, [
    activeDragVisibleTabId,
    activeVisibleTabId,
    columns,
    count,
    focusedSlotId,
    indexBySortableId,
    range,
    sortableIds
  ])
  // Why: dnd-kit re-renders every mounted tab when this array's identity changes, and tab writes rebuild it.
  const [mountedSortableIds, setMountedSortableIds] = useState(tabStripWindow.sortableIds)
  if (!sameStringArray(mountedSortableIds, tabStripWindow.sortableIds)) {
    setMountedSortableIds(tabStripWindow.sortableIds)
  }
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!wrapTabs || !strip || !activeVisibleTabId || activeDragVisibleTabId !== null) {
      return
    }
    const revealActiveRow = (): void => {
      const slot = findTabStripSlot(strip, activeVisibleTabId)
      if (!slot) {
        return
      }
      const { top, bottom } = slot.getBoundingClientRect()
      const viewportTop = strip.getBoundingClientRect().top + strip.clientTop
      const viewportBottom = viewportTop + strip.clientHeight
      strip.scrollTop += Math.min(0, top - viewportTop) + Math.max(0, bottom - viewportBottom)
    }
    revealActiveRow()
    const observer = new ResizeObserver(revealActiveRow)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [activeDragVisibleTabId, activeVisibleTabId, columns, sortableIds, stripRef, wrapTabs])
  // Why the scroller renders inside: its ref must attach before the window state's layout effect reads it.
  return (
    <SortableContext items={mountedSortableIds}>
      {renderStrip(tabStripWindow.segments, columns)}
    </SortableContext>
  )
}
