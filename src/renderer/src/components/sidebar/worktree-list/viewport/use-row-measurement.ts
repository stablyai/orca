import { useMemo } from 'react'
import type React from 'react'
import { buildLineageRowRekeyMap, getActiveStickyIndexesForScroll } from './virtual-rows'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeListVirtualizer } from './use-virtualizer'
import { useVirtualRowRemovalAnimation } from './use-row-removal-animation'

// Sticky headers and removal animations consume semantic outer frames, never closing slots.
export function useVirtualRowMeasurementSync(args: {
  renderRows: RenderRow[]
  virtualization: WorktreeListVirtualizer
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const { renderRows, virtualization, scrollRef } = args
  const virtualItems = virtualization.outerItems
  const activeStickyIndexes = getActiveStickyIndexesForScroll({
    rows: renderRows,
    rangeStartIndex: virtualization.rangeStartIndex,
    scrollOffset: virtualization.presentationOffset,
    stickyHeaderIndexes: virtualization.stickyHeaderIndexes,
    virtualItems
  })
  virtualization.activeStickyHeaderIndexRef.current = activeStickyIndexes.groupIndex
  virtualization.activeStickyHostIndexRef.current = activeStickyIndexes.hostIndex
  const lineageRowRekeys = useMemo(() => buildLineageRowRekeyMap(renderRows), [renderRows])
  useVirtualRowRemovalAnimation({
    renderRows,
    rekeyedRowKeys: lineageRowRekeys,
    scrollRef,
    virtualItems
  })
  return { virtualItems, measureVirtualRowElement: virtualization.measureVirtualRowElement }
}
