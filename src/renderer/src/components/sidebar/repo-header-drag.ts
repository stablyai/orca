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
  // Call from the repo header's onPointerDown. The drag does NOT start
  // immediately — it arms a pending session that promotes to an active drag
  // only once the pointer moves past DRAG_THRESHOLD_PX. A pointerup before
  // promotion releases without committing, so the surrounding click handler
  // still fires and toggles the group's collapsed state.
  onHandlePointerDown: (event: React.PointerEvent<HTMLElement>, repoId: string) => void
}

// Pixels the pointer must travel before we promote a pending press into a
// real drag. Below this we treat the press as a normal click (toggle group).
const DRAG_THRESHOLD_PX = 4

export function useRepoHeaderDrag({
  orderedRepoIds,
  onCommit,
  getScrollContainer
}: UseRepoHeaderDragArgs): RepoHeaderDragController {
  const [state, setState] = useState<RepoDragState>(INITIAL_STATE)
  // Tracks whether a press has begun (armed) regardless of promotion. Used
  // only to gate window listeners; visible drag state lives in `state`.
  const [sessionArmed, setSessionArmed] = useState(false)
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
    startX: number
    startY: number
    // false until the pointer moves past DRAG_THRESHOLD_PX. While false the
    // session exists but no drop indicator is shown and pointerup is treated
    // as a click rather than a drop.
    promoted: boolean
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
      // Why anchor to the target header (not midpoint between headers): the
      // space between two repo group headers is filled with worktree cards,
      // so the midpoint falls *inside another repo's content*. Sitting the
      // indicator just above the target header keeps it at the visual top of
      // where the dragged group would land.
      const INDICATOR_GAP_PX = 4
      const indicatorY =
        insertBefore >= rects.length
          ? rects.at(-1)!.bottom + INDICATOR_GAP_PX
          : Math.max(0, rects[insertBefore].top - INDICATOR_GAP_PX)
      return { dropIndex: insertBefore, dropIndicatorY: indicatorY }
    },
    []
  )

  const endDrag = useCallback((commit: boolean) => {
    const session = dragSessionRef.current
    if (!session) {
      setState(INITIAL_STATE)
      setSessionArmed(false)
      return
    }
    try {
      session.handleEl.releasePointerCapture(session.pointerId)
    } catch {
      // capture may already be released (pointercancel, element unmounted)
    }
    if (session.promoted) {
      // After a real drag, the browser still fires a click on the header.
      // Swallow exactly one click in capture phase so it doesn't toggle the
      // group's collapsed state. Scope to the dragged handle (and ancestors)
      // so an unrelated click that races between pointerup and the failsafe
      // teardown isn't silently eaten.
      const handleEl = session.handleEl
      const swallow = (e: MouseEvent): void => {
        const target = e.target as Node | null
        if (target && handleEl.contains(target)) {
          e.stopPropagation()
          e.preventDefault()
        }
        window.removeEventListener('click', swallow, true)
      }
      window.addEventListener('click', swallow, true)
      // Failsafe: if no click ever arrives (e.g. pointercancel), drop the
      // listener after a tick so future clicks aren't silenced.
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    }
    // Only commit a reorder if the press was promoted into a real drag —
    // otherwise the press was effectively a click, and the surrounding
    // header onClick handler will toggle collapse.
    const finalIndex =
      commit && session.promoted && latestDropIndexRef.current !== null
        ? latestDropIndexRef.current
        : null
    dragSessionRef.current = null
    setState(INITIAL_STATE)
    setSessionArmed(false)
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

  // Window-level listeners while a session is armed — pointer capture on the
  // header element ensures the events still fire even if the pointer leaves
  // it. The session may be unpromoted (waiting for a movement past the
  // threshold to become a real drag) or promoted (drop indicator visible).
  useEffect(() => {
    if (!sessionArmed) {
      return
    }
    const onPointerMove = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      if (!session.promoted) {
        const dx = e.clientX - session.startX
        const dy = e.clientY - session.startY
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
          return
        }
        session.promoted = true
        setState({ draggingRepoId: session.repoId, dropIndex: null, dropIndicatorY: null })
      }
      const drop = computeDrop(e.clientY)
      if (!drop) {
        return
      }
      setState((prev) =>
        prev.dropIndex === drop.dropIndex && prev.dropIndicatorY === drop.dropIndicatorY
          ? prev
          : { draggingRepoId: session.repoId, ...drop }
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
  }, [sessionArmed, computeDrop, endDrag])

  // From pointerdown onward (armed session, before/after promotion) force a
  // grabbing cursor and disable text selection across the whole window so
  // the user gets immediate feedback that the press registered, even before
  // they've moved past DRAG_THRESHOLD_PX.
  useEffect(() => {
    if (!sessionArmed) {
      return
    }
    const body = document.body
    const prevCursor = body.style.cursor
    const prevUserSelect = body.style.userSelect
    body.style.cursor = 'grabbing'
    body.style.userSelect = 'none'
    return () => {
      body.style.cursor = prevCursor
      body.style.userSelect = prevUserSelect
    }
  }, [sessionArmed])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, repoId: string) => {
      // Only react to primary button. Ignore right/middle clicks.
      if (event.button !== 0) {
        return
      }
      // Don't intercept presses that originated on a nested control (the
      // `+` create-worktree button or the chevron). Those have their own
      // click semantics and shouldn't arm a drag.
      const target = event.target as HTMLElement | null
      if (target && target !== event.currentTarget && target.closest('button')) {
        return
      }
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
        handleEl,
        startX: event.clientX,
        startY: event.clientY,
        promoted: false
      }
      // Don't show drag UI yet. Wait for movement past DRAG_THRESHOLD_PX so a
      // simple click on the header still toggles collapse via the surrounding
      // onClick handler.
      setSessionArmed(true)
    },
    []
  )

  return { state, onHandlePointerDown }
}
