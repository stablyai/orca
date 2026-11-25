import React, { useMemo, useState, type RefObject } from 'react'
import { SortableContext } from '@dnd-kit/sortable'
import { sameStringArray } from '@/runtime/web-session-tabs-sync/snapshots/state-equality-core'
import { useActiveDragVisibleTabId } from '../../tab-group/drag/tab-drag-context'
import {
  buildTabStripSegments,
  useTabStripWindowState,
  type TabStripSegment
} from './tab-strip-window'

/** Owns the strip's window state, so scrolling re-renders the strip alone, not the tab bar around it. */
export function WindowedTabStrip({
  stripRef,
  subscribeToStripResize,
  sortableIds,
  activeVisibleTabId,
  renderStrip
}: {
  stripRef: RefObject<HTMLDivElement | null>
  subscribeToStripResize: (listener: () => void) => () => void
  sortableIds: string[]
  activeVisibleTabId: string | null
  /** Renders the scroller (which must attach `stripRef`) with these mounted runs of the tabs. */
  renderStrip: (segments: readonly TabStripSegment[]) => React.ReactNode
}): React.JSX.Element {
  const count = sortableIds.length
  const { range, focusedSlotId } = useTabStripWindowState(stripRef, count, subscribeToStripResize)
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
    const segments = buildTabStripSegments(count, range, keptIndices)
    const mountedIds = segments.flatMap((segment) =>
      segment.kind === 'tabs' ? sortableIds.slice(segment.start, segment.end) : []
    )
    return { segments, sortableIds: mountedIds }
  }, [
    activeDragVisibleTabId,
    activeVisibleTabId,
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
  // Why the scroller renders inside: its ref must attach before the window state's layout effect reads it.
  return (
    <SortableContext items={mountedSortableIds}>
      {renderStrip(tabStripWindow.segments)}
    </SortableContext>
  )
}
