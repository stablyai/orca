import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { DiffSection } from './diff-section-types'
import {
  connectCombinedDiffExtent,
  publishCombinedDiffMeasurements
} from './combined-diff-extent-dom'

export function useCombinedDiffExtent(
  viewport: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  mark?: (offset: number) => void,
  sections?: readonly (Pick<DiffSection, 'key'> & Partial<DiffSection>)[],
  context?: string
): void {
  // Install before measurements can ask the virtualizer to compensate a size change.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  useLayoutEffect(() => {
    return viewport
      ? connectCombinedDiffExtent(viewport, mark, () =>
          publishCombinedDiffMeasurements(virtualizer)
        )
      : undefined
  }, [context, mark, viewport, virtualizer])
  useLayoutEffect(() => {
    publishCombinedDiffMeasurements(virtualizer, sections)
  })
}

export function useCombinedDiffViewport() {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const beforeDetachRef = useRef<(() => void) | null>(null)
  const releaseViewport = useCallback(() => {
    const release = beforeDetachRef.current
    beforeDetachRef.current = null
    release?.()
  }, [])
  const [viewportNode, setViewportNode] = useState<HTMLDivElement | null>(null)
  const setViewport = useCallback(
    (node: HTMLDivElement | null) => {
      if (scrollContainerRef.current !== node) {
        releaseViewport()
      }
      scrollContainerRef.current = node
      setViewportNode(node)
    },
    [releaseViewport]
  )
  return { scrollContainerRef, viewportNode, setViewport, beforeDetachRef, releaseViewport }
}
