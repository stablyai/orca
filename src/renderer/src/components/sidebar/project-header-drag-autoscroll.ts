import { useCallback, useRef, type RefObject } from 'react'

import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import { getWorktreeSidebarDragAutoscroll } from './worktree-sidebar-drag-autoscroll'

type ProjectHeaderDragAutoscrollArgs = {
  dragSessionRef: RefObject<ProjectHeaderDragSession | null>
  getScrollContainerRef: RefObject<() => HTMLElement | null>
  refreshHeaderRects: () => void
  // Runs once per frame while a promoted drag is active, after any scroll step,
  // so the drop preview stays in step with a pointer that never moves again.
  onFrame: (session: ProjectHeaderDragSession) => void
}

export type ProjectHeaderDragAutoscrollController = {
  ensureAutoscroll: () => void
  cancelAutoscroll: () => void
}

export function useProjectHeaderDragAutoscroll({
  dragSessionRef,
  getScrollContainerRef,
  refreshHeaderRects,
  onFrame
}: ProjectHeaderDragAutoscrollArgs): ProjectHeaderDragAutoscrollController {
  const lastFrameTimeRef = useRef<number | null>(null)
  const frameIdRef = useRef<number | null>(null)
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  const cancelAutoscroll = useCallback(() => {
    if (frameIdRef.current !== null) {
      window.cancelAnimationFrame(frameIdRef.current)
      frameIdRef.current = null
    }
    lastFrameTimeRef.current = null
  }, [])

  const runFrame = useCallback(
    (frameTime: number) => {
      frameIdRef.current = null
      const session = dragSessionRef.current
      const container = getScrollContainerRef.current()
      if (!session?.promoted || !container) {
        cancelAutoscroll()
        return
      }

      const previousFrameTime = lastFrameTimeRef.current ?? frameTime
      lastFrameTimeRef.current = frameTime
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

      onFrameRef.current(session)

      frameIdRef.current = window.requestAnimationFrame(runFrame)
    },
    [cancelAutoscroll, dragSessionRef, getScrollContainerRef, refreshHeaderRects]
  )

  const ensureAutoscroll = useCallback(() => {
    if (frameIdRef.current !== null) {
      return
    }
    lastFrameTimeRef.current = null
    frameIdRef.current = window.requestAnimationFrame(runFrame)
  }, [runFrame])

  return { ensureAutoscroll, cancelAutoscroll }
}
