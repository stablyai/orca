import { shouldExcludeQuickOpenRelPath, shouldIncludeQuickOpenPath } from './quick-open-filter'
import { quickOpenRecentCandidateSet } from './quick-open-recent-candidates'

export function quickOpenListingPathFilter(
  excluded: readonly string[],
  candidatePaths?: readonly string[]
): (path: string) => boolean {
  const candidates =
    candidatePaths === undefined ? undefined : quickOpenRecentCandidateSet(candidatePaths)
  return (path) =>
    shouldIncludeQuickOpenPath(path) &&
    !shouldExcludeQuickOpenRelPath(path, excluded) &&
    (!candidates || candidates.has(path))
}
