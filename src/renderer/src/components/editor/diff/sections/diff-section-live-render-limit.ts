import type { DiffSection } from './diff-section-types'
import {
  getLargeDiffRenderLimitFromCounts,
  countLinesEmptyAsZero,
  type LargeDiffRenderLimit
} from '../../../../../../shared/source-control/diff/large-diff-render-limit'

export function getLiveDiffSectionRenderLimit({
  section,
  modifiedContent,
  modifiedLineCount
}: {
  section: DiffSection
  modifiedContent: string
  modifiedLineCount?: number
}): LargeDiffRenderLimit {
  return getLargeDiffRenderLimitFromCounts({
    originalLineCount:
      section.largeDiffRenderLimit?.lineCounts?.original ??
      countLinesEmptyAsZero(section.originalContent),
    modifiedLineCount: modifiedLineCount ?? countLinesEmptyAsZero(modifiedContent),
    originalCharacterCount: section.originalContent.length,
    modifiedCharacterCount: modifiedContent.length
  })
}
