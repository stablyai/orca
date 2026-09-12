import { useCallback, useLayoutEffect, useRef } from 'react'
import type { FileDiffMetadata, PostRenderPhase } from '@pierre/diffs'
import type { PierreDiffInstance } from './PierreDiffSurface'
import type { DiffSearchMatch } from './pierre-diff-search'
import type { DiffSearchSide } from './PierreDiffSearchBar'
import {
  getPierreSearchRanges,
  paintPierreSearchHighlights,
  pierreSearchRevealLine
} from './pierre-diff-search-view'
import { scrollPierreDiffToLine } from './pierre-diff-scroll'

export function usePierreDiffSearchView({
  fileDiff,
  side,
  matches,
  active
}: {
  fileDiff: FileDiffMetadata
  side: DiffSearchSide
  matches?: DiffSearchMatch[]
  active?: DiffSearchMatch
}) {
  const viewRef = useRef<{ host: HTMLElement; instance: PierreDiffInstance } | null>(null)
  const owner = useRef({})
  const frame = useRef<number | null>(null)
  const pending = useRef(false)
  const nativeRange = useRef<{ start: Range; end: Range } | null>(null)
  const schedule = useCallback(() => {
    if (frame.current !== null) {
      return
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const view = viewRef.current
      if (!view || !matches) {
        paintPierreSearchHighlights(owner.current)
        return
      }
      const { host, instance } = view
      if (active && pending.current) {
        if (
          instance.revealLine(pierreSearchRevealLine(fileDiff, active.range.start.line + 1, side))
        ) {
          return
        }
        scrollPierreDiffToLine({
          host,
          container: host.closest('.scrollbar-editor'),
          lineNumber: active.range.start.line + 1,
          side,
          linePosition: instance.getLinePosition?.(active.range.start.line + 1, side),
          hunkIndex: 0,
          hunkCount: 0
        })
      }
      const ranges = getPierreSearchRanges(host, fileDiff, side, matches, active)
      nativeRange.current =
        ranges.activeStart && ranges.activeEnd
          ? { start: ranges.activeStart, end: ranges.activeEnd }
          : null
      paintPierreSearchHighlights(owner.current, ranges)
      if (pending.current && ranges.active.length) {
        const range = ranges.active[0]
        const row = range.startContainer.parentElement?.closest<HTMLElement>('[data-code]')
        if (row) {
          const rect = range.getBoundingClientRect(),
            viewport = row.getBoundingClientRect()
          if (rect.left < viewport.left || rect.right > viewport.right) {
            row.scrollLeft += rect.left - viewport.left - row.clientWidth / 3
          }
        }
        pending.current = false
      }
    })
  }, [matches, active, fileDiff, side])
  useLayoutEffect(() => {
    pending.current = Boolean(active)
    schedule()
    const token = owner.current
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
      }
      frame.current = null
      nativeRange.current = null
      paintPierreSearchHighlights(token)
    }
  }, [schedule, active])
  const onPostRender = useCallback(
    (host: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      if (phase === 'unmount') {
        viewRef.current = null
        paintPierreSearchHighlights(owner.current)
      } else {
        viewRef.current = { host, instance }
        schedule()
      }
    },
    [schedule]
  )
  const selectActive = useCallback(() => {
    const range = nativeRange.current
    if (!range?.start.startContainer.isConnected || !range.end.endContainer.isConnected) {
      return
    }
    const root = range.start.startContainer.getRootNode() as ShadowRoot & {
      getSelection?: () => Selection | null
    }
    root
      .getSelection?.()
      ?.setBaseAndExtent(
        range.start.startContainer,
        range.start.startOffset,
        range.end.endContainer,
        range.end.endOffset
      )
  }, [])
  return { onPostRender, selectActive }
}
