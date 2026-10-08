import {
  QuickOpenPathRanker,
  rankQuickOpenFiles,
  type QuickOpenIndexedFile
} from '../quick-open-search'

export type ExistingFileMatch = {
  kind: 'existing-file'
  matchKind: 'exact-path' | 'exact-basename' | 'literal-basename' | 'fuzzy'
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

// Why: multi-word text without path or filename syntax cannot overtake ranking
// as a file match, so callers may treat its search ranking as already final.
export function isUnambiguousSearchQuery(query: string): boolean {
  const trimmed = query.trim()
  return /\s/.test(trimmed) && !hasPathSeparator(trimmed) && !hasFilenameExtension(trimmed)
}

export function isLikelyNewFileIntent(query: string): boolean {
  const trimmed = query.trim()
  if (hasPathSeparator(trimmed)) {
    return true
  }
  if (/\s/.test(trimmed)) {
    return false
  }
  return hasFilenameExtension(trimmed) || /^\.[^.].*$/.test(trimmed)
}

function findLiteralFilenameMatches(
  query: string,
  files: readonly QuickOpenIndexedFile[],
  limit: number
): ExistingFileMatch[] {
  // Natural ordering avoids arbitrary fuzzy scores among literal filename matches.
  const ranker = new QuickOpenPathRanker('', limit)
  const seen = new Set<string>()
  for (const file of files) {
    if (file.lowerFilename.includes(query) && !seen.has(file.path)) {
      seen.add(file.path)
      ranker.consider(file.path)
    }
  }
  return ranker.result().paths.map((relativePath) => ({
    kind: 'existing-file',
    matchKind: 'literal-basename',
    relativePath
  }))
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
  const exactMatches = dedupeMatches([...exactPathMatches, ...exactBasenameMatches])
  if (exactMatches.length >= limit) {
    return exactMatches.slice(0, limit)
  }
  const preferFilenames = !isLikelyNewFileIntent(normalizedQuery) && !/\s/.test(normalizedQuery)
  const preferredMatches = preferFilenames
    ? dedupeMatches([
        ...exactMatches,
        ...findLiteralFilenameMatches(lowerQuery, indexedFiles, limit)
      ])
    : exactMatches
  if (preferredMatches.length >= limit) {
    return preferredMatches.slice(0, limit)
  }
  const fuzzyMatches = rankQuickOpenFiles(normalizedQuery, indexedFiles, limit).map((file) => ({
    kind: 'existing-file' as const,
    matchKind: 'fuzzy' as const,
    relativePath: file.path
  }))

  return dedupeMatches([...preferredMatches, ...fuzzyMatches]).slice(0, limit)
}
