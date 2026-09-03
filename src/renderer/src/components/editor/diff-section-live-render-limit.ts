import type { DiffSection } from './diff-section-types'
import {
  getLargeDiffRenderLimitFromCounts,
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
  const modifiedLineCount = modifiedContent.length === 0 ? 0 : modifiedContent.split('\n').length

  return getLargeDiffRenderLimitFromCounts({
    originalLineCount: section.largeDiffRenderLimit?.lineCounts?.original ?? 0,
    modifiedLineCount,
    originalCharacterCount: section.originalContent.length,
    modifiedCharacterCount: modifiedContent.length
  })
}
