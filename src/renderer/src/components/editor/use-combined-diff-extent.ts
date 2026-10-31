import { useLayoutEffect, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  connectCombinedDiffExtent,
  publishCombinedDiffMeasurements
} from './combined-diff-extent-dom'

export function useCombinedDiffExtent(
  viewport: RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  mark?: (offset: number) => void
): void {
  // Install before measurements can ask the virtualizer to compensate a size change.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  useLayoutEffect(() => {
    const node = viewport.current
    return node
      ? connectCombinedDiffExtent(node, mark, () => publishCombinedDiffMeasurements(virtualizer))
      : undefined
  }, [mark, viewport, virtualizer])
  useLayoutEffect(() => {
    publishCombinedDiffMeasurements(virtualizer)
  })
}
