import ignore from 'ignore'
import type { SourceControlFileGroup } from '../../../../../../shared/source-control-file-groups'
import type { SourceControlPathEntry } from './file-filter'

export type SourceControlExtensionCount = { extension: string; count: number }

/** Git paths use slash separators on every host; dotfiles and trailing dots have no extension. */
export function getSourceControlFileExtension(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const dot = basename.lastIndexOf('.')
  return dot > 0 && dot < basename.length - 1 ? basename.slice(dot) : ''
}

/** Counts each changed path once even when it appears in both staged and unstaged changes. */
export function getSourceControlExtensionCounts(
  paths: readonly string[]
): SourceControlExtensionCount[] {
  const counts = new Map<string, number>()
  for (const path of new Set(paths)) {
    const extension = getSourceControlFileExtension(path)
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([extension, count]) => ({
      extension,
      count
    }))
}

/** Compiles selected groups once; negation applies within each group, as in a gitignore file. */
export function createSourceControlFileVisibilityFilter(
  excludedExtensions: ReadonlySet<string>,
  hiddenGroups: readonly SourceControlFileGroup[]
): ((entry: SourceControlPathEntry) => boolean) | undefined {
  if (excludedExtensions.size === 0 && hiddenGroups.length === 0) {
    return undefined
  }
  const matchers = hiddenGroups.map((group) => ignore({ ignorecase: false }).add(group.patterns))
  return (entry) =>
    !excludedExtensions.has(getSourceControlFileExtension(entry.path)) &&
    (!ignore.isPathValid(entry.path) || !matchers.some((matcher) => matcher.ignores(entry.path)))
}
