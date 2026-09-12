import type { DiffSection } from './diff-section-types'
import {
  getLargeDiffRenderLimitFromCounts,
  countLinesEmptyAsZero,
  type LargeDiffRenderLimit
} from './large-diff-render-limit'

export function getLiveDiffSectionRenderLimit({
  section,
  modifiedContent
}: {
  section: DiffSection
  modifiedContent: string
}): LargeDiffRenderLimit {
  // Why: the renderer no longer owns a text model, so count lines from the draft itself.
  const modifiedLineCount = countLinesEmptyAsZero(modifiedContent)

  return getLargeDiffRenderLimitFromCounts({
    originalLineCount:
      section.largeDiffRenderLimit?.lineCounts?.original ??
      countLinesEmptyAsZero(section.originalContent),
    modifiedLineCount,
    originalCharacterCount: section.originalContent.length,
    modifiedCharacterCount: modifiedContent.length
  })
}
