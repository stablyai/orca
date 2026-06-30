import { shouldExcludeQuickOpenRelPath, shouldIncludeQuickOpenPath } from './quick-open-filter'

const GLOB_META_CHARS = new Set(['*', '?', '[', ']', '{', '}', '\\'])

function escapeGlobSegment(segment: string): string {
  let out = ''
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    out += GLOB_META_CHARS.has(char) ? `\\${char}` : char
  }
  return out
}

function normalizeListedRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null
  }
  return normalized
}

function basenameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? relativePath : relativePath.slice(slash + 1)
}

export function buildQuickOpenBasenameGlob(basename: string): string | null {
  if (!isSafeQuickOpenBasename(basename)) {
    return null
  }
  return `**/${escapeGlobSegment(basename)}`
}

export function isSafeQuickOpenBasename(basename: string): boolean {
  return Boolean(basename) && !basename.includes('/') && !basename.includes('\\')
}

export type UniqueQuickOpenBasenameCollector = {
  add(relativePath: string): boolean
  result(): string | null
}

export function createUniqueQuickOpenBasenameCollector(
  basename: string,
  excludePathPrefixes: readonly string[] = []
): UniqueQuickOpenBasenameCollector {
  const matches = new Set<string>()

  return {
    add(relativePath) {
      const normalized = normalizeListedRelativePath(relativePath)
      if (!normalized) {
        return false
      }
      if (shouldExcludeQuickOpenRelPath(normalized, excludePathPrefixes)) {
        return false
      }
      if (!shouldIncludeQuickOpenPath(normalized) || basenameOf(normalized) !== basename) {
        return false
      }
      matches.add(normalized)
      return matches.size > 1
    },
    result() {
      return matches.size === 1 ? [...matches][0] : null
    }
  }
}

export function resolveUniqueQuickOpenBasenameFromPaths(
  files: readonly string[],
  basename: string,
  excludePathPrefixes: readonly string[] = []
): string | null {
  const collector = createUniqueQuickOpenBasenameCollector(basename, excludePathPrefixes)
  for (const file of files) {
    if (collector.add(file)) {
      return null
    }
  }
  return collector.result()
}
