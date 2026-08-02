import { rankQuickOpenFiles, type QuickOpenIndexedFile } from '../quick-open-search'

export type ExistingFileMatch = {
  kind: 'existing-file'
  matchKind: 'exact-path' | 'exact-basename' | 'fuzzy'
  relativePath: string
}

function normalizeFileMatchQuery(query: string): string {
  return query.trim().replace(/\\/g, '/')
}

function hasPathSeparator(query: string): boolean {
  return /[\\/]/.test(query)
}

function hasFilenameExtension(query: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.[^\\/]+$/.test(query.trim())
}

export function isLikelyNewFileIntent(query: string): boolean {
  return hasPathSeparator(query) || hasFilenameExtension(query)
}

function dedupeMatches(matches: ExistingFileMatch[]): ExistingFileMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    if (seen.has(match.relativePath)) {
      return false
    }
    seen.add(match.relativePath)
    return true
  })
}

export function findExistingFileMatches(
  query: string,
  indexedFiles: readonly QuickOpenIndexedFile[],
  limit: number
): ExistingFileMatch[] {
  const normalizedQuery = normalizeFileMatchQuery(query)
  if (!normalizedQuery || limit <= 0) {
    return []
  }
  const lowerQuery = normalizedQuery.toLowerCase()
  const exactPathMatches = indexedFiles
    .filter((file) => file.lowerPath === lowerQuery)
    .map((file) => ({
      kind: 'existing-file' as const,
      matchKind: 'exact-path' as const,
      relativePath: file.path
    }))
  const exactBasenameMatches = indexedFiles
    .filter((file) => file.lowerFilename === lowerQuery)
    .map((file) => ({
      kind: 'existing-file' as const,
      matchKind: 'exact-basename' as const,
      relativePath: file.path
    }))
  const fuzzyMatches = rankQuickOpenFiles(normalizedQuery, indexedFiles, limit).map((file) => ({
    kind: 'existing-file' as const,
    matchKind: 'fuzzy' as const,
    relativePath: file.path
  }))

  return dedupeMatches([...exactPathMatches, ...exactBasenameMatches, ...fuzzyMatches]).slice(
    0,
    limit
  )
}
