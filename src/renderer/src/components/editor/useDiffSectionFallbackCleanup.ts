import { useEffect } from 'react'
import { removeDiffSectionMeasuredHeight } from './diff-section-height-cache'

export function useDiffSectionFallbackCleanup({
  disposeDiffModels,
  index,
  isLargeDiffLimited,
  setSectionHeights
}: {
  disposeDiffModels: () => void
  index: number
  isLargeDiffLimited: boolean
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
}): void {
  useEffect(() => {
    if (isLargeDiffLimited) {
      setSectionHeights((prev) => removeDiffSectionMeasuredHeight(prev, index))
      disposeDiffModels()
    }
  }, [disposeDiffModels, index, isLargeDiffLimited, setSectionHeights])
}
