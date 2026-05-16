import type { GitDiffResult } from '../../../../shared/types'

const DIFF_LINE_HEIGHT = 19
const DIFF_SECTION_PADDING_HEIGHT = 19
const MIN_DIFF_SECTION_BODY_HEIGHT = 60
const DIFF_SECTION_HEADER_HEIGHT = 28

type DiffSectionBodyHeightInput = {
  measuredContentHeight: number | undefined
  originalContent: string
  modifiedContent: string
  useIntrinsicImageHeight: boolean
}

export function isIntrinsicHeightImageDiff(diffResult: GitDiffResult | null | undefined): boolean {
  return diffResult?.kind === 'binary' && diffResult.mimeType?.startsWith('image/') === true
}

export function getDiffSectionBodyHeight({
  measuredContentHeight,
  originalContent,
  modifiedContent,
  useIntrinsicImageHeight
}: DiffSectionBodyHeightInput): number | undefined {
  if (useIntrinsicImageHeight) {
    return undefined
  }

  if (measuredContentHeight !== undefined && measuredContentHeight > 0) {
    return measuredContentHeight + DIFF_SECTION_PADDING_HEIGHT
  }

  return Math.max(
    MIN_DIFF_SECTION_BODY_HEIGHT,
    Math.max(originalContent.split('\n').length, modifiedContent.split('\n').length) *
      DIFF_LINE_HEIGHT +
      DIFF_SECTION_PADDING_HEIGHT
  )
}

export function getDiffSectionEstimatedHeight({
  collapsed,
  measuredContentHeight,
  originalContent,
  modifiedContent,
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
      useIntrinsicImageHeight
    }) ?? MIN_DIFF_SECTION_BODY_HEIGHT)
  )
}
