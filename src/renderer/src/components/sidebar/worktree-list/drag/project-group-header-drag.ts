import { useCallback, useEffect, useRef, useState } from 'react'

import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getNextRootProjectOrder } from '../../../../../../shared/root-project-order'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import {
  INITIAL_PROJECT_GROUP_DRAG_STATE,
  PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX,
  type ProjectGroupDragState,
  type ProjectGroupHeaderDragController,
  type ProjectGroupHeaderDragSession,
  type UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import {
  toProjectGroupDragState,
  type ProjectGroupHeaderDropTarget
} from './project-group-header-reparent-drop'
import {
  computeSessionProjectGroupHeaderDropTarget,
  createProjectGroupHeaderDragSession,
  refreshProjectGroupHeaderDragSessionRects
} from './project-group-header-drag-start'
import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'
import { hasPointerBeenReleased } from './header-drag-pointer-release'
import { swallowNextClickOnDragHandle } from './header-drag-click-swallow'

// Virtualized rows can unmount during drag; pointer events and cached model indices keep drops stable.

export function useProjectGroupHeaderDrag(
  args: UseProjectGroupHeaderDragArgs
): ProjectGroupHeaderDragController {
  const [state, setState] = useState<ProjectGroupDragState>(INITIAL_PROJECT_GROUP_DRAG_STATE)
  const [sessionArmed, setSessionArmed] = useState(false)
  const latestDropTargetRef = useRef<ProjectGroupHeaderDropTarget | null>(null)
  const latestInputsRef = useRef(args)
  useEffect(() => {
    latestInputsRef.current = args
  })

  const autoscrollLastFrameTimeRef = useRef<number | null>(null)
  const autoscrollFrameIdRef = useRef<number | null>(null)
  const dragSessionRef = useRef<ProjectGroupHeaderDragSession | null>(null)
  const clickSwallowTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshHeaderRects = useCallback(() => {
    refreshProjectGroupHeaderDragSessionRects(
      latestInputsRef.current.getScrollContainer(),
      dragSessionRef.current
    )
  }, [])

  const computeDrop = useCallback(
    (pointerY: number): ProjectGroupHeaderDropTarget | null =>
      computeSessionProjectGroupHeaderDropTarget(
        pointerY,
        dragSessionRef.current,
        latestInputsRef.current
      ),
    []
  )

  const applyDrop = useCallback(
    (session: ProjectGroupHeaderDragSession, drop: ProjectGroupHeaderDropTarget | null) => {
      latestDropTargetRef.current = drop
      const draggedGroup = latestInputsRef.current.projectGroupById.get(session.groupId)
      const catalogHostId = draggedGroup
        ? getCatalogHostIdForExecutionHost(getRepoExecutionHostId(draggedGroup))
        : null
      const nextState = toProjectGroupDragState(session.groupId, catalogHostId, drop)
      setState((prev) =>
        prev.draggingGroupId === nextState.draggingGroupId &&
        prev.dropIndex === nextState.dropIndex &&
        prev.dropIndicatorY === nextState.dropIndicatorY &&
        prev.dropTargetGroupId === nextState.dropTargetGroupId &&
        prev.dropTargetCatalogHostId === nextState.dropTargetCatalogHostId
          ? prev
          : nextState
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
        setState(INITIAL_PROJECT_GROUP_DRAG_STATE)
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
      setState(INITIAL_PROJECT_GROUP_DRAG_STATE)
      setSessionArmed(false)
      if (!dropTarget) {
        return
      }
      const inputs = latestInputsRef.current
      const liveRepos = inputs.getLiveRepos?.() ?? []
      void commitProjectGroupHeaderDragDrop({
        session,
        dropTarget,
        projectGroupById: inputs.projectGroupById,
        repos: liveRepos,
        allowMixedProjectReorder: inputs.allowMixedProjectReorder,
        sidebarGroupChildItemIdsByGroupId: inputs.sidebarGroupChildItemIdsByGroupId,
        repoById: inputs.repoById,
        pinnedRepoHeaderIds: inputs.pinnedRepoHeaderIds,
        orderedRepoIds: inputs.orderedRepoIds,
        sidebarProjectGroupHeaderIdsByBucket: inputs.sidebarProjectGroupHeaderIdsByBucket,
        onCommitRootProjectOrder: inputs.onCommitRootProjectOrder,
        nextRootProjectOrder: getNextRootProjectOrder(liveRepos, [
          ...inputs.projectGroupById.values()
        ]),
        onCommitProjectGroupUpdate: inputs.onCommitProjectGroupUpdate,
        onCommitProjectGroupOrder: inputs.onCommitProjectGroupOrder
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
    const onPointerMove = (event: PointerEvent): void => {
      const session = dragSessionRef.current
      if (!session || event.pointerId !== session.pointerId) {
        return
      }
      if (hasPointerBeenReleased(event)) {
        endDrag(false)
        return
      }
      session.latestPointerY = event.clientY
      if (!session.promoted) {
        const dx = event.clientX - session.startX
        const dy = event.clientY - session.startY
        const thresholdSq =
          PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX * PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX
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
        setState(toProjectGroupDragState(session.groupId, null, null))
      }
      refreshHeaderRects()
      applyDrop(session, computeDrop(event.clientY))
      ensureAutoscroll()
    }
    const onPointerUp = (event: PointerEvent): void => {
      if (dragSessionRef.current?.pointerId === event.pointerId) {
        endDrag(true)
      }
    }
    const onPointerCancel = (event: PointerEvent): void => {
      if (dragSessionRef.current?.pointerId === event.pointerId) {
        endDrag(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
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
    if (state.draggingGroupId === null) {
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
  }, [state.draggingGroupId])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>, groupId: string) => {
      const inputs = latestInputsRef.current
      const session = createProjectGroupHeaderDragSession({
        event,
        groupId,
        rootProjectHeaderKeys: inputs.rootProjectHeaderKeys,
        projectGroupById: inputs.projectGroupById,
        pinnedRepoHeaderIds: inputs.pinnedRepoHeaderIds,
        repoById: inputs.repoById,
        projectGroupOwnerHostIdByGroupId: inputs.projectGroupOwnerHostIdByGroupId,
        sidebarProjectGroupHeaderIdsByBucket: inputs.sidebarProjectGroupHeaderIdsByBucket,
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
