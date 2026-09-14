import { useCallback } from 'react'
import type React from 'react'
import { getWorktreeSidebarDragAutoscroll } from '../../worktree-sidebar-drag-autoscroll'
import { getPointerDropStatusTarget } from './status-target'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import type { WorktreeDragRuntime } from './use-runtime'
import type { WorktreeDragSession } from './use-session'
import { applyWorktreeDropPreview, clearWorktreeDropPreview } from './row-state'

// The HTML5 drag equivalent of pointer autoscroll: the browser gives no move events while
// hovering the edge, so re-derive the drop preview from the last known point each frame.
export function useWorktreeNativeDragAutoscroll(args: {
  ctx: WorktreeDropCommitContext
  session: WorktreeDragSession
  runtime: WorktreeDragRuntime
  scrollRef: React.RefObject<HTMLDivElement | null>
  markScrollMovement: () => void
}): () => void {
  const { ctx, session, runtime, scrollRef, markScrollMovement } = args
  const {
    nativeAutoscrollFrameIdRef,
    nativeAutoscrollLastFrameTimeRef,
    nativeLatestPointRef,
    cancelWorktreeNativeAutoscroll,
    clearWorktreeDrag,
    setWorktreeDragState
  } = runtime

  const runFrame = useCallback(
    (frameTime: number) => {
      nativeAutoscrollFrameIdRef.current = null
      const point = nativeLatestPointRef.current
      const container = scrollRef.current
      const dragSession = session.worktreeDragSessionRef.current
      if (!point || !container || !dragSession) {
        cancelWorktreeNativeAutoscroll()
        return
      }

      const previousFrameTime = nativeAutoscrollLastFrameTimeRef.current ?? frameTime
      nativeAutoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point,
        containerRect: container.getBoundingClientRect(),
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        markScrollMovement()
        container.scrollTop = autoscroll.scrollTop
        if (!session.refreshWorktreeDragSession()) {
          clearWorktreeDrag()
          return
        }
        const drop = ctx.computeWorktreeDrop(point.clientY)
        if (!drop) {
          const target = getPointerDropStatusTarget({
            container,
            x: point.clientX,
            y: point.clientY
          })
          const statusDrop = target.status
            ? ctx.computeWorktreeStatusDrop({
                pointerY: point.clientY,
                status: target.status,
                draggedIds: dragSession.reorderDraggedIds
              })
            : null
          if (statusDrop) {
            setWorktreeDragState((prev) =>
              applyWorktreeDropPreview(prev, statusDrop, { pointerY: point.clientY })
            )
            return
          }
          setWorktreeDragState((prev) => clearWorktreeDropPreview(prev, { pointerY: null }))
        } else {
          setWorktreeDragState((prev) =>
            applyWorktreeDropPreview(prev, drop, { pointerY: point.clientY })
          )
        }
      }

      nativeAutoscrollFrameIdRef.current = window.requestAnimationFrame(runFrame)
    },
    [
      cancelWorktreeNativeAutoscroll,
      clearWorktreeDrag,
      ctx,
      markScrollMovement,
      nativeAutoscrollFrameIdRef,
      nativeAutoscrollLastFrameTimeRef,
      nativeLatestPointRef,
      scrollRef,
      session,
      setWorktreeDragState
    ]
  )

  return useCallback(() => {
    if (nativeAutoscrollFrameIdRef.current !== null) {
      return
    }
    nativeAutoscrollLastFrameTimeRef.current = null
    nativeAutoscrollFrameIdRef.current = window.requestAnimationFrame(runFrame)
  }, [nativeAutoscrollFrameIdRef, nativeAutoscrollLastFrameTimeRef, runFrame])
}
