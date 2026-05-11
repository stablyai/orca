import { useCallback, useEffect, useRef, useState } from 'react'

// Why pointer events instead of HTML5 DnD: rows are absolutely-positioned by
// react-virtual and unmount/remount as scroll changes, so DnD enter/leave fire
// against stale targets. With pointer events we cache the active set of repo
// header positions and compute the drop index from the live pointer Y.

export type RepoDragState = {
  draggingRepoId: string | null
  // Insertion index in the orderedRepoIds array where the dragged repo would
  // land if released now. null while not dragging.
  dropIndex: number | null
  // Y coordinate (in scrollContainer's local space, i.e. relative to its
  // top-left content origin including current scrollTop offset) where the
  // insertion bar should be drawn. null while not dragging.
  dropIndicatorY: number | null
}

const INITIAL_STATE: RepoDragState = {
  draggingRepoId: null,
  dropIndex: null,
  dropIndicatorY: null
}

export type UseRepoHeaderDragArgs = {
  orderedRepoIds: string[]
  onCommit: (orderedIds: string[]) => void
  // Returns the scroll container that hosts the virtualized rows. Bounding
  // rects are read from this element so insertion-bar Y values stay correct
  // when the sidebar is resized.
  getScrollContainer: () => HTMLElement | null
}

type HeaderRect = {
  repoId: string
  // top/bottom in scrollContainer-local space (page-coord top minus container
  // page-coord top, plus current scrollTop).
  top: number
  bottom: number
}

export type RepoHeaderDragController = {
  state: RepoDragState
  // Call from the drag handle's onPointerDown. Stops propagation upstream so
  // the surrounding header click-to-collapse handler does not fire.
  onHandlePointerDown: (event: React.PointerEvent<HTMLElement>, repoId: string) => void
}

export function useRepoHeaderDrag({
  orderedRepoIds,
  onCommit,
  getScrollContainer
}: UseRepoHeaderDragArgs): RepoHeaderDragController {
  const [state, setState] = useState<RepoDragState>(INITIAL_STATE)
  // Why: endDrag reads dropIndex on pointerup, but binding the listener with
  // dropIndex in deps would re-add window listeners on every pointermove.
  // The ref tracks the latest computed value without invalidating the effect.
  const latestDropIndexRef = useRef<number | null>(null)
  latestDropIndexRef.current = state.dropIndex
  // Keep callbacks stable: they read from refs so we don't re-bind window
  // listeners every render.
  const orderedIdsRef = useRef(orderedRepoIds)
  orderedIdsRef.current = orderedRepoIds
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const getContainerRef = useRef(getScrollContainer)
  getContainerRef.current = getScrollContainer

  const dragSessionRef = useRef<{
    repoId: string
    pointerId: number
    headerRects: HeaderRect[]
    handleEl: HTMLElement
  } | null>(null)

  const computeDrop = useCallback(
    (pointerY: number): { dropIndex: number; dropIndicatorY: number } | null => {
      const session = dragSessionRef.current
      const container = getContainerRef.current()
      if (!session || !container) {
        return null
      }
      const containerRect = container.getBoundingClientRect()
      // Translate pointer to container-local coords + scroll.
      const localY = pointerY - containerRect.top + container.scrollTop
      const rects = session.headerRects
      if (rects.length === 0) {
        return null
      }
      // Find the first header whose midpoint is below the pointer.
      let insertBefore = rects.length
      for (let i = 0; i < rects.length; i++) {
        const mid = (rects[i].top + rects[i].bottom) / 2
        if (localY < mid) {
          insertBefore = i
          break
        }
      }
      const indicatorY =
        insertBefore === 0
          ? rects[0].top
          : insertBefore >= rects.length
            ? rects.at(-1)!.bottom
            : (rects[insertBefore - 1].bottom + rects[insertBefore].top) / 2
      return { dropIndex: insertBefore, dropIndicatorY: indicatorY }
    },
    []
  )

  const endDrag = useCallback((commit: boolean) => {
    const session = dragSessionRef.current
    if (!session) {
      setState(INITIAL_STATE)
      return
    }
    try {
      session.handleEl.releasePointerCapture(session.pointerId)
    } catch {
      // capture may already be released (pointercancel, element unmounted)
    }
    const finalIndex =
      commit && latestDropIndexRef.current !== null ? latestDropIndexRef.current : null
    dragSessionRef.current = null
    setState(INITIAL_STATE)
    if (finalIndex === null) {
      return
    }
    const ids = orderedIdsRef.current
    const fromIndex = ids.indexOf(session.repoId)
    if (fromIndex === -1) {
      return
    }
    // Splice fromIndex out, then insert at finalIndex (adjusting if the
    // removal shifted indices).
    const next = ids.slice()
    next.splice(fromIndex, 1)
    const insertAt = finalIndex > fromIndex ? finalIndex - 1 : finalIndex
    if (insertAt === fromIndex) {
      return
    }
    next.splice(insertAt, 0, session.repoId)
    onCommitRef.current(next)
  }, [])

  // Window-level listeners while dragging — pointer capture on the handle
  // element ensures the events still fire even if the pointer leaves it.
  useEffect(() => {
    if (!state.draggingRepoId) {
      return
    }
    const onPointerMove = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      const drop = computeDrop(e.clientY)
      if (!drop) {
        return
      }
      setState((prev) =>
        prev.dropIndex === drop.dropIndex && prev.dropIndicatorY === drop.dropIndicatorY
          ? prev
          : { draggingRepoId: prev.draggingRepoId, ...drop }
      )
    }
    const onPointerUp = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      endDrag(true)
    }
    const onPointerCancel = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      endDrag(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        endDrag(false)
      }
    }
    const onBlur = (): void => endDrag(false)

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [state.draggingRepoId, computeDrop, endDrag])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, repoId: string) => {
      // Only react to primary button. Ignore right/middle clicks.
      if (event.button !== 0) {
        return
      }
      // Stop the surrounding header's click-to-collapse from firing.
      event.preventDefault()
      event.stopPropagation()

      const container = getContainerRef.current()
      if (!container) {
        return
      }
      // Snapshot every repo header's position in scrollContainer-local space.
      // Using a snapshot (vs reading the DOM each pointermove) means the drop
      // computation does not depend on those rows still being mounted —
      // critical because react-virtual will unmount them as the user scrolls.
      const containerRect = container.getBoundingClientRect()
      const headerEls = container.querySelectorAll<HTMLElement>('[data-repo-header-id]')
      const headerRects: HeaderRect[] = []
      headerEls.forEach((el) => {
        const id = el.getAttribute('data-repo-header-id')
        if (!id) {
          return
        }
        const rect = el.getBoundingClientRect()
        headerRects.push({
          repoId: id,
          top: rect.top - containerRect.top + container.scrollTop,
          bottom: rect.bottom - containerRect.top + container.scrollTop
        })
      })
      headerRects.sort((a, b) => a.top - b.top)

      const handleEl = event.currentTarget
      try {
        handleEl.setPointerCapture(event.pointerId)
      } catch {
        // setPointerCapture can throw if the element is detached; the global
        // pointer listeners still fire, so dragging keeps working.
      }
      dragSessionRef.current = {
        repoId,
        pointerId: event.pointerId,
        headerRects,
        handleEl
      }
      const drop = computeDrop(event.clientY)
      setState({
        draggingRepoId: repoId,
        dropIndex: drop?.dropIndex ?? null,
        dropIndicatorY: drop?.dropIndicatorY ?? null
      })
    },
    [computeDrop]
  )

  return { state, onHandlePointerDown }
}
