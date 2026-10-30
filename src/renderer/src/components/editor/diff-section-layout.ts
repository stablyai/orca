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
  // Ignore stale pre-limit Monaco heights so render-limit fallback rows stay bounded.
  return LARGE_DIFF_FALLBACK_BODY_HEIGHT
}

/** Keep deferred, limited and newly loading rows at bounded fallback height so empty in-flight content cannot shrink the list. */
export function usesLargeDiffFallbackHeight(
  section: Pick<
    DiffSection,
    'added' | 'largeDiffRenderLimit' | 'loading' | 'loadOnDemand' | 'path' | 'removed'
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

  // Estimate collapsed regions before Monaco reports height so full-file size cannot flash or jump the virtualizer.
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
  isLargeDiffLimited = false
}: DiffSectionBodyHeightInput & {
  collapsed: boolean
  isLargeDiffLimited?: boolean
}): number {
  if (collapsed) {
    return DIFF_SECTION_HEADER_HEIGHT
  }

  if (isLargeDiffLimited) {
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

/** Share estimates across worktree and review viewers, matching the row’s bounded fallback sizing. */
export function getDiffSectionRowEstimatedHeight(
  section: Pick<
    DiffSection,
    | 'added'
    | 'collapsed'
    | 'diffResult'
    | 'largeDiffRenderLimit'
    | 'loading'
    | 'loadOnDemand'
    | 'modifiedContent'
    | 'originalContent'
    | 'path'
    | 'removed'
  >,
  measuredContentHeight: number | undefined
): number {
  return getDiffSectionEstimatedHeight({
    collapsed: section.collapsed,
    measuredContentHeight,
    originalContent: section.originalContent,
    modifiedContent: section.modifiedContent,
    changedLineCount:
      section.added === undefined && section.removed === undefined
        ? undefined
        : (section.added ?? 0) + (section.removed ?? 0),
    useIntrinsicImageHeight: isIntrinsicHeightImageDiff(section.diffResult),
    isLargeDiffLimited: usesLargeDiffFallbackHeight(section),
    lineCounts: section.largeDiffRenderLimit?.lineCounts ?? undefined
  })
}
