import { useCallback, useMemo, type PointerEvent as ReactPointerEvent } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isHostHeaderActionTarget, readHostHeaderRects } from './host-header-drag-dom'
import { useOrderedHeaderDrag } from './ordered-header-drag'

export type HostDragState = {
  draggingHostId: ExecutionHostId | null
  dropIndex: number | null
  dropIndicatorY: number | null
}

export type UseHostHeaderDragArgs = {
  orderedHostIds: readonly ExecutionHostId[]
  onCommit: (orderedIds: ExecutionHostId[]) => void
  getScrollContainer: () => HTMLElement | null
}

export type HostHeaderDragController = {
  state: HostDragState
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, hostId: ExecutionHostId) => void
}

export function useHostHeaderDrag({
  orderedHostIds,
  onCommit,
  getScrollContainer
}: UseHostHeaderDragArgs): HostHeaderDragController {
  const handleCommit = useCallback(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ids come from orderedHostIds, which the drag only permutes.
    (orderedIds: string[]) => onCommit(orderedIds as ExecutionHostId[]),
    [onCommit]
  )
  const drag = useOrderedHeaderDrag({
    orderedIds: orderedHostIds,
    onCommit: handleCommit,
    getScrollContainer,
    readHeaderRects: readHostHeaderRects,
    isActionTarget: isHostHeaderActionTarget
  })
  const state = useMemo<HostDragState>(
    () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only ids passed in as ExecutionHostId reach the drag state.
      draggingHostId: drag.state.draggingId as ExecutionHostId | null,
      dropIndex: drag.state.dropIndex,
      dropIndicatorY: drag.state.dropIndicatorY
    }),
    [drag.state.dropIndex, drag.state.dropIndicatorY, drag.state.draggingId]
  )
  return { state, onHandlePointerDown: drag.onHandlePointerDown }
}
