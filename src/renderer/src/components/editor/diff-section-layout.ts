import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import { shouldLoadCombinedDiffOnDemand } from './combined-diff-on-demand-load'
import type { DiffSection } from './diff-section-types'
import { countLinesLikeSplit, type DiffLineCounts } from './large-diff-render-limit'

const DIFF_LINE_HEIGHT = 19
const DIFF_SECTION_PADDING_HEIGHT = 19
const MIN_DIFF_SECTION_BODY_HEIGHT = 60
const DIFF_SECTION_HEADER_HEIGHT = 28
const DIFF_UNCHANGED_CONTEXT_LINE_ESTIMATE = 12
const MAX_UNMEASURED_TEXT_BODY_LINES = 80
const LARGE_DIFF_FALLBACK_BODY_HEIGHT = 160

type DiffSectionBodyHeightInput = {
  measuredContentHeight: number | undefined
  originalContent: string
  modifiedContent: string
  changedLineCount?: number
  useIntrinsicImageHeight: boolean
  lineCounts?: DiffLineCounts
}

export function isIntrinsicHeightImageDiff(diffResult: GitDiffResult | null | undefined): boolean {
  return diffResult?.kind === 'binary' && diffResult.mimeType?.startsWith('image/') === true
}

export function getLargeDiffFallbackBodyHeight(): number {
  // Why: section measurements may be stale Monaco heights from before a diff
  // crossed the render limit; the fallback must always stay bounded.
  return LARGE_DIFF_FALLBACK_BODY_HEIGHT
}

/**
 * Rows that size from the bounded fallback instead of their (absent) content:
 * render-limited rows, rows still waiting behind the load prompt, and — while
 * the fetch is in flight — rows the user just loaded, so starting a load does
 * not shrink the section to the empty-content minimum and shift the list.
 */
export function usesLargeDiffFallbackHeight(
  section: Pick<
    DiffSection,
    'added' | 'area' | 'largeDiffRenderLimit' | 'loading' | 'loadOnDemand' | 'path' | 'removed'
  >
): boolean {
  return (
    section.largeDiffRenderLimit?.limited === true ||
    section.loadOnDemand === true ||
    (section.loading && shouldLoadCombinedDiffOnDemand(section))
  )
}

export function getDiffSectionBodyHeight({
  measuredContentHeight,
  originalContent,
  modifiedContent,
  changedLineCount,
  useIntrinsicImageHeight,
  lineCounts
}: DiffSectionBodyHeightInput): number | undefined {
  if (useIntrinsicImageHeight) {
    return undefined
  }

  if (measuredContentHeight !== undefined && measuredContentHeight > 0) {
    return measuredContentHeight + DIFF_SECTION_PADDING_HEIGHT
  }

  const fullLineCount = lineCounts
    ? Math.max(lineCounts.original, lineCounts.modified)
    : Math.max(countLinesLikeSplit(originalContent), countLinesLikeSplit(modifiedContent))
  const estimatedLineCount =
    changedLineCount !== undefined
      ? Math.min(
          fullLineCount,
          Math.max(2, changedLineCount + DIFF_UNCHANGED_CONTEXT_LINE_ESTIMATE)
        )
      : Math.min(fullLineCount, MAX_UNMEASURED_TEXT_BODY_LINES)

  // Why: combined diffs hide unchanged regions inside Monaco. Before Monaco
  // reports its collapsed content height, sizing from full file length makes
  // large files flash open and forces the virtualizer to jump on scroll.
  return Math.max(
    MIN_DIFF_SECTION_BODY_HEIGHT,
    estimatedLineCount * DIFF_LINE_HEIGHT + DIFF_SECTION_PADDING_HEIGHT
  )
}

export function getDiffSectionEstimatedHeight({
  collapsed,
  measuredContentHeight,
  originalContent,
  modifiedContent,
  changedLineCount,
  useIntrinsicImageHeight,
  lineCounts,
  isLargeDiffLimited = false,
  isLoadOnDemand = false
}: DiffSectionBodyHeightInput & {
  collapsed: boolean
  isLargeDiffLimited?: boolean
  isLoadOnDemand?: boolean
}): number {
  if (collapsed) {
    return DIFF_SECTION_HEADER_HEIGHT
  }

  if (isLargeDiffLimited || isLoadOnDemand) {
    return DIFF_SECTION_HEADER_HEIGHT + getLargeDiffFallbackBodyHeight()
  }

  return (
    DIFF_SECTION_HEADER_HEIGHT +
    (getDiffSectionBodyHeight({
      measuredContentHeight,
      originalContent,
      modifiedContent,
      changedLineCount,
      useIntrinsicImageHeight,
      lineCounts
    }) ?? MIN_DIFF_SECTION_BODY_HEIGHT)
  )
}
