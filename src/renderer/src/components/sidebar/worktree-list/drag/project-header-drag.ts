import { useCallback, useEffect, useRef, useState } from 'react'

import type { Repo } from '../../../../../../shared/repo-types'
import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import {
  INITIAL_REPO_DRAG_STATE,
  PROJECT_HEADER_DRAG_THRESHOLD_PX,
  type ProjectHeaderDragSession,
  type RepoDragState,
  type RepoHeaderDragController,
  type UseRepoHeaderDragArgs
} from './project-header-drag-contract'
import { toRepoDragState, type ProjectHeaderDropTarget } from './project-header-group-drop'
import {
  computeSessionProjectHeaderDropTarget,
  createProjectHeaderDragSession,
  refreshProjectHeaderDragSessionRects
} from './project-header-drag-start'
import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'
import { hasPointerBeenReleased } from './header-drag-pointer-release'
import { swallowNextClickOnDragHandle } from './header-drag-click-swallow'

// Virtualized rows can unmount during drag; pointer events and cached header geometry avoid stale drop targets.

export function useRepoHeaderDrag(args: UseRepoHeaderDragArgs): RepoHeaderDragController {
  const [state, setState] = useState<RepoDragState>(INITIAL_REPO_DRAG_STATE)
  const [sessionArmed, setSessionArmed] = useState(false)
  const latestDropTargetRef = useRef<ProjectHeaderDropTarget | null>(null)
  const latestInputsRef = useRef(args)
  useEffect(() => {
    latestInputsRef.current = args
  })

  const autoscrollLastFrameTimeRef = useRef<number | null>(null)
  const autoscrollFrameIdRef = useRef<number | null>(null)
  const dragSessionRef = useRef<ProjectHeaderDragSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshHeaderRects = useCallback(() => {
    refreshProjectHeaderDragSessionRects(
      latestInputsRef.current.getScrollContainer(),
      dragSessionRef.current
    )
  }, [])

  const computeDrop = useCallback(
    (pointerY: number): ProjectHeaderDropTarget | null =>
      computeSessionProjectHeaderDropTarget(
        pointerY,
        dragSessionRef.current,
        latestInputsRef.current
      ),
    []
  )

  const applyDrop = useCallback(
    (session: ProjectHeaderDragSession, drop: ProjectHeaderDropTarget | null) => {
      latestDropTargetRef.current = drop
      const next = toRepoDragState(session, drop)
      setState((prev) =>
        prev.draggingRepoId === next.draggingRepoId &&
        prev.dropIndex === next.dropIndex &&
        prev.dropIndicatorY === next.dropIndicatorY &&
        prev.dropTargetGroupId === next.dropTargetGroupId &&
        prev.dropTargetCatalogHostId === next.dropTargetCatalogHostId
          ? prev
          : next
      )
    },
    []
  )

  const cancelAutoscroll = useCallback(() => {
    if (autoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(autoscrollFrameIdRef.current)
      autoscrollFrameIdRef.current = null
    }
    autoscrollLastFrameTimeRef.current = null
  }, [])

  const endDrag = useCallback(
    (commit: boolean) => {
      cancelAutoscroll()
      const session = dragSessionRef.current
      if (!session) {
        latestDropTargetRef.current = null
        setState(INITIAL_REPO_DRAG_STATE)
        setSessionArmed(false)
        return
      }
      try {
        session.handleEl.releasePointerCapture(session.pointerId)
      } catch {
        // Pointer cancellation or unmount may already have released capture.
      }
      if (session.promoted) {
        if (clickSwallowTimeoutRef.current !== null) {
          clearTimeout(clickSwallowTimeoutRef.current)
        }
        clickSwallowTimeoutRef.current = swallowNextClickOnDragHandle(session.handleEl)
      }
      const dropTarget = commit && session.promoted ? latestDropTargetRef.current : null
      latestDropTargetRef.current = null
      dragSessionRef.current = null
      setState(INITIAL_REPO_DRAG_STATE)
      setSessionArmed(false)
      if (!dropTarget) {
        return
      }
      const inputs = latestInputsRef.current
      void commitProjectHeaderDragDrop({
        session,
        dropTarget,
        onCommitRootProjectOrder: inputs.onCommitRootProjectOrder,
        sidebarRepoHeaderIdsByBucket: inputs.sidebarRepoHeaderIdsByBucket,
        sidebarGroupChildItemIdsByGroupId: inputs.sidebarGroupChildItemIdsByGroupId,
        projectGroupById: inputs.projectGroupById,
        pinnedRepoHeaderIds: inputs.pinnedRepoHeaderIds,
        orderedRepoIds: inputs.orderedRepoIds,
        repoById: inputs.repoById,
        liveRepos: inputs.getLiveRepos(),
        projectGroups: inputs.projectGroups,
        usesProjectGroupOrdering: inputs.usesProjectGroupOrdering,
        onCommitRepoOrder: inputs.onCommitRepoOrder,
        onCommitProjectGroupOrder: inputs.onCommitProjectGroupOrder,
        onCommitProjectGroupUpdate: inputs.onCommitProjectGroupUpdate,
        onMoveToGroupHeader: inputs.onMoveToGroupHeader
      })
    },
    [cancelAutoscroll]
  )

  const runAutoscrollFrame = useCallback(
    function runFrame(frameTime: number) {
      autoscrollFrameIdRef.current = null
      const session = dragSessionRef.current
      const container = latestInputsRef.current.getScrollContainer()
      if (!session?.promoted || !container) {
        cancelAutoscroll()
        return
      }
      const previousFrameTime = autoscrollLastFrameTimeRef.current ?? frameTime
      autoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point: { clientX: 0, clientY: session.latestPointerY },
        containerRect: container.getBoundingClientRect(),
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        container.scrollTop = autoscroll.scrollTop
        refreshHeaderRects()
      }
      applyDrop(session, computeDrop(session.latestPointerY))
      autoscrollFrameIdRef.current = window.requestAnimationFrame(runFrame)
    },
    [applyDrop, cancelAutoscroll, computeDrop, refreshHeaderRects]
  )

  const ensureAutoscroll = useCallback(() => {
    if (autoscrollFrameIdRef.current !== null) {
      return
    }
    autoscrollLastFrameTimeRef.current = null
    autoscrollFrameIdRef.current = window.requestAnimationFrame(runAutoscrollFrame)
  }, [runAutoscrollFrame])

  useEffect(() => {
    if (!sessionArmed) {
      return
    }
    const onPointerMove = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || e.pointerId !== session.pointerId) {
        return
      }
      if (hasPointerBeenReleased(e)) {
        endDrag(false)
        return
      }
      session.latestPointerY = e.clientY
      if (!session.promoted) {
        const dx = e.clientX - session.startX
        const dy = e.clientY - session.startY
        const thresholdSq = PROJECT_HEADER_DRAG_THRESHOLD_PX * PROJECT_HEADER_DRAG_THRESHOLD_PX
        if (dx * dx + dy * dy < thresholdSq) {
          return
        }
        session.promoted = true
        // Virtualization may detach headers; global listeners keep dragging alive without capture.
        if (session.handleEl.isConnected) {
          try {
            session.handleEl.setPointerCapture(session.pointerId)
          } catch {}
        }
        refreshHeaderRects()
        setState(toRepoDragState(session, null))
      }
      refreshHeaderRects()
      applyDrop(session, computeDrop(e.clientY))
      ensureAutoscroll()
    }
    const onPointerEnd = (e: PointerEvent): void => {
      const session = dragSessionRef.current
      if (session && e.pointerId === session.pointerId) {
        endDrag(e.type === 'pointerup')
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        endDrag(false)
      }
    }
    const onBlur = (): void => endDrag(false)

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
      cancelAutoscroll()
    }
  }, [
    applyDrop,
    cancelAutoscroll,
    computeDrop,
    endDrag,
    ensureAutoscroll,
    refreshHeaderRects,
    sessionArmed
  ])

  useEffect(
    () => () => {
      if (clickSwallowTimeoutRef.current !== null) {
        clearTimeout(clickSwallowTimeoutRef.current)
        clickSwallowTimeoutRef.current = null
      }
    },
    []
  )

  useEffect(() => {
    if (state.draggingRepoId === null) {
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
  }, [state.draggingRepoId])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, repo: Repo, groupRepo?: Repo | null) => {
      const inputs = latestInputsRef.current
      const session = createProjectHeaderDragSession({
        event,
        repo,
        groupRepo,
        projectGroups: inputs.projectGroups,
        projectGroupById: inputs.projectGroupById,
        allowSlotReorder: inputs.allowSlotReorder,
        sidebarRepoHeaderIdsByBucket: inputs.sidebarRepoHeaderIdsByBucket,
        rootProjectHeaderKeys: inputs.rootProjectHeaderKeys,
        pinnedRepoHeaderIds: inputs.pinnedRepoHeaderIds,
        repoById: inputs.repoById,
        getScrollContainer: inputs.getScrollContainer
      })
      if (!session) {
        return
      }
      dragSessionRef.current = session
      setSessionArmed(true)
    },
    []
  )

  return { state, onHandlePointerDown }
}
