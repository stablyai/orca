import { useCallback, useLayoutEffect, useRef } from 'react'
import type { PostRenderPhase } from '@pierre/diffs'
import { useAppStore } from '@/store'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { scrollPierreDiffToLine } from './pierre-diff-scroll'

export function usePierreDiffNoteNavigation({
  worktreeId,
  filePath,
  comments
}: {
  worktreeId: string
  filePath: string
  comments: readonly DecoratedDiffComment[]
}) {
  const requestedId = useAppStore((state) => state.scrollToDiffCommentId)
  const target =
    worktreeId && requestedId
      ? comments.find(
          (comment) =>
            comment.id === requestedId &&
            comment.worktreeId === worktreeId &&
            comment.filePath === filePath
        )
      : undefined
  const viewRef = useRef<{ host: HTMLElement; instance: PierreDiffInstance } | null>(null)
  const frameRef = useRef<number | null>(null)
  const cancel = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
    }
    frameRef.current = null
  }, [])
  const schedule = useCallback(() => {
    if (!target || frameRef.current !== null) {
      return
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const view = viewRef.current
      if (
        !view ||
        !view.host.isConnected ||
        useAppStore.getState().scrollToDiffCommentId !== target.id
      ) {
        return
      }
      const { host, instance } = view
      const container = host.closest<HTMLElement>('.scrollbar-editor')
      if (!container || container.clientHeight === 0) {
        return
      }
      // Reveal only the note's context; Pierre retains that expansion after acknowledgement.
      if (instance.revealLine(target.lineNumber)) {
        return
      }
      const card = host.querySelector<HTMLElement>(
        `[data-diff-comment-id="${CSS.escape(target.id)}"]`
      )
      const rect = card?.getBoundingClientRect()
      if (rect && rect.height > 0) {
        const viewport = container.getBoundingClientRect()
        container.scrollTop +=
          rect.top - viewport.top - Math.max(0, (container.clientHeight - rect.height) / 2)
        const visible = card!.getBoundingClientRect()
        if (visible.bottom > viewport.top && visible.top < viewport.bottom) {
          useAppStore.getState().setScrollToDiffCommentId(null)
        }
        return
      }
      // The anchor can exist in the virtual layout before its annotation is mounted.
      scrollPierreDiffToLine({
        host,
        container,
        lineNumber: target.lineNumber,
        side: 'additions',
        linePosition: instance.getLinePosition?.(target.lineNumber, 'additions'),
        hunkIndex: 0,
        hunkCount: 0
      })
    })
  }, [target])
  useLayoutEffect(() => {
    schedule()
    return cancel
  }, [schedule, cancel])

  return useCallback(
    (host: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      if (phase === 'unmount') {
        viewRef.current = null
        cancel()
      } else {
        viewRef.current = { host, instance }
        schedule()
      }
    },
    [cancel, schedule]
  )
}
