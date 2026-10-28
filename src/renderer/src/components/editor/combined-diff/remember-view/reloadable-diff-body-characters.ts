import type { DiffSection } from '../../diff-section-types'

export function reloadableBodyCharacters(section: DiffSection): number {
  if (section.dirty || section.saveConflict || section.loading || section.loadOnDemand) {
    return 0
  }
  const result = section.diffResult
  // Text results mirror the section strings; binary bodies live only in the result.
  return (
    section.originalContent.length +
    section.modifiedContent.length +
    (result && result.originalContent !== section.originalContent
      ? result.originalContent.length
      : 0) +
    (result && result.modifiedContent !== section.modifiedContent
      ? result.modifiedContent.length
      : 0)
  )
}
