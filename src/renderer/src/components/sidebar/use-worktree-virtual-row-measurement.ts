import { useCallback, useLayoutEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  buildLineageRowRekeyMap,
  getRenderRowKey,
  pruneStaleVirtualRowElementCache,
  type RenderRow
} from './worktree-list-virtual-rows'
import { countRecordKeysByReference } from './worktree-list-behavior'

type Virtualizer = {
  elementsCache: Map<unknown, HTMLDivElement>
  measureElement: (element: HTMLDivElement | null) => void
}

export function useWorktreeVirtualRowMeasurement(args: {
  renderRows: readonly RenderRow[]
  virtualizer: Virtualizer
  isCurrentVirtualRowElement: (element: Element) => boolean
}) {
  const { renderRows, virtualizer, isCurrentVirtualRowElement } = args
  const prCacheLen = useAppStore((state) => countRecordKeysByReference(state.prCache))
  const issueCacheLen = useAppStore((state) => countRecordKeysByReference(state.issueCache))
  const renderRowKeySignature = useMemo(
    () => renderRows.map(getRenderRowKey).join('\n'),
    [renderRows]
  )
  const activeRenderRowKeys = useMemo(() => new Set(renderRows.map(getRenderRowKey)), [renderRows])
  const lineageRowRekeys = useMemo(() => buildLineageRowRekeyMap(renderRows), [renderRows])
  const measureMountedRows = useCallback(() => {
    virtualizer.elementsCache.forEach((element) => {
      if (isCurrentVirtualRowElement(element)) {
        virtualizer.measureElement(element)
      }
    })
  }, [isCurrentVirtualRowElement, virtualizer])
  const measureVirtualRowElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        virtualizer.measureElement(null)
        return
      }
      if (isCurrentVirtualRowElement(element)) {
        virtualizer.measureElement(element)
      }
    },
    [isCurrentVirtualRowElement, virtualizer]
  )
  useLayoutEffect(() => {
    pruneStaleVirtualRowElementCache({ activeRowKeys: activeRenderRowKeys, virtualizer })
    // Why: a stale retained element after delete/collapse measures 0px and corrupts the next slot; measure only key-matched rows.
    measureMountedRows()
    const frameId = window.requestAnimationFrame(measureMountedRows)
    return () => window.cancelAnimationFrame(frameId)
  }, [
    activeRenderRowKeys,
    prCacheLen,
    issueCacheLen,
    measureMountedRows,
    renderRowKeySignature,
    virtualizer
  ])
  return { lineageRowRekeys, measureVirtualRowElement }
}
