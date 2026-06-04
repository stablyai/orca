import { useMemo } from 'react'
import { computeLineStats } from './diff-line-stats'
import { getDiffSectionBodyHeight, isIntrinsicHeightImageDiff } from './diff-section-layout'
import type { DiffSection } from './diff-section-types'

export function useDiffSectionLayoutMetrics({
  section,
  sectionHeight
}: {
  section: DiffSection
  sectionHeight: number | undefined
}): {
  lineStats: ReturnType<typeof computeLineStats> | null
  sectionBodyHeight: number | undefined
  useIntrinsicImageHeight: boolean
} {
  const lineStats = useMemo(
    () =>
      section.loading || section.error
        ? null
        : computeLineStats(section.originalContent, section.modifiedContent, section.status),
    [
      section.error,
      section.loading,
      section.originalContent,
      section.modifiedContent,
      section.status
    ]
  )
  const changedLineCount = useMemo(() => {
    if (lineStats) {
      return lineStats.added + lineStats.removed
    }
    if (section.added === undefined && section.removed === undefined) {
      return undefined
    }
    return (section.added ?? 0) + (section.removed ?? 0)
  }, [lineStats, section.added, section.removed])
  // Why: image diffs need document-flow height in the combined view; the text
  // fallback only knows line counts and would squash screenshots into one row.
  const useIntrinsicImageHeight = isIntrinsicHeightImageDiff(section.diffResult)
  const sectionBodyHeight = getDiffSectionBodyHeight({
    measuredContentHeight: sectionHeight,
    originalContent: section.originalContent,
    modifiedContent: section.modifiedContent,
    changedLineCount,
    useIntrinsicImageHeight
  })

  return { lineStats, sectionBodyHeight, useIntrinsicImageHeight }
}
