import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import type { FileDiffMetadata, PostRenderPhase } from '@pierre/diffs'
import { diffScrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { getPierreDiffChangeTargets } from './pierre-diff-change-targets'
import { scrollPierreDiffToLine } from './pierre-diff-scroll'

export function usePierreDiffScrollRestore(
  modelKey: string,
  containerRef: RefObject<HTMLElement | null>,
  fileDiff: FileDiffMetadata | null
) {
  const restoredKey = useRef<string | null>(null)
  const frame = useRef<number | null>(null)
  useLayoutEffect(() => {
    const container = containerRef.current
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
      }
      frame.current = null
      if (container && restoredKey.current === modelKey) {
        setWithLRU(diffScrollTopCache, modelKey, container.scrollTop)
      }
      restoredKey.current = null
    }
  }, [modelKey, containerRef])

  return useCallback(
    (host: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      if (phase === 'unmount') {
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current)
        }
        frame.current = null
        return
      }
      if (restoredKey.current === modelKey || frame.current !== null) {
        return
      }
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        const container = containerRef.current
        if (!container || !host.isConnected || host.getBoundingClientRect().height === 0) {
          return
        }
        restoredKey.current = modelKey
        const saved = diffScrollTopCache.get(modelKey)
        if (saved !== undefined) {
          container.scrollTop = saved
          return
        }
        const targets = getPierreDiffChangeTargets(fileDiff)
        const target = targets[0]
        if (target) {
          scrollPierreDiffToLine({
            host,
            container,
            ...target,
            hunkIndex: 0,
            hunkCount: targets.length,
            linePosition: instance.getLinePosition?.(target.lineNumber, target.side)
          })
        }
      })
    },
    [modelKey, containerRef, fileDiff]
  )
}
