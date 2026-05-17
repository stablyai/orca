import type { GitDiffResult } from '../../../../shared/types'

const DIFF_LINE_HEIGHT = 19
const DIFF_SECTION_PADDING_HEIGHT = 19
const MIN_DIFF_SECTION_BODY_HEIGHT = 60
const DIFF_SECTION_HEADER_HEIGHT = 28
const DIFF_UNCHANGED_CONTEXT_LINE_ESTIMATE = 12
const MAX_UNMEASURED_TEXT_BODY_LINES = 80

type DiffSectionBodyHeightInput = {
  measuredContentHeight: number | undefined
  originalContent: string
  modifiedContent: string
  changedLineCount?: number
  useIntrinsicImageHeight: boolean
}

export function isIntrinsicHeightImageDiff(diffResult: GitDiffResult | null | undefined): boolean {
  return diffResult?.kind === 'binary' && diffResult.mimeType?.startsWith('image/') === true
}

export function getDiffSectionBodyHeight({
  measuredContentHeight,
  originalContent,
  modifiedContent,
  changedLineCount,
  useIntrinsicImageHeight
}: DiffSectionBodyHeightInput): number | undefined {
  if (useIntrinsicImageHeight) {
    return undefined
  }

  if (measuredContentHeight !== undefined && measuredContentHeight > 0) {
    return measuredContentHeight + DIFF_SECTION_PADDING_HEIGHT
  }

  const fullLineCount = Math.max(
    originalContent.split('\n').length,
    modifiedContent.split('\n').length
  )
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
  useIntrinsicImageHeight
}: DiffSectionBodyHeightInput & { collapsed: boolean }): number {
  if (collapsed) {
    return DIFF_SECTION_HEADER_HEIGHT
  }

  return (
    DIFF_SECTION_HEADER_HEIGHT +
    (getDiffSectionBodyHeight({
      measuredContentHeight,
      originalContent,
      modifiedContent,
      changedLineCount,
      useIntrinsicImageHeight
    }) ?? MIN_DIFF_SECTION_BODY_HEIGHT)
  )
}
