import type { DiffSection } from './diff-section-types'

// Why: `diffResult === null` subsumes a dirty check — `dirty` is only ever set from a mounted
// editor's content compare, which implies content was already loaded.
export function shouldRequestCombinedDiffSectionLoad(
  section: Pick<DiffSection, 'diffResult' | 'error'> | undefined,
  isLoading: boolean
): boolean {
  return Boolean(section && section.diffResult === null && !section.error && !isLoading)
}
