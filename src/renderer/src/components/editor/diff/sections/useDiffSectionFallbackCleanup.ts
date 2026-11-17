import { useEffect } from 'react'
import { removeDiffSectionMeasuredHeight } from './diff-section-height-cache'

export function useDiffSectionFallbackCleanup({
  index,
  isLargeDiffLimited,
  setSectionHeights
}: {
  index: number
  isLargeDiffLimited: boolean
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
}): void {
  useEffect(() => {
    if (isLargeDiffLimited) {
      setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
    }
  }, [index, isLargeDiffLimited, setSectionHeights])
}
