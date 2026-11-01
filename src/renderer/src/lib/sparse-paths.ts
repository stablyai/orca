const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/

export function isAbsoluteSparseDirectoryPath(value: string): boolean {
  const entry = value.trim()
  return entry.startsWith('/') || entry.startsWith('\\') || WINDOWS_DRIVE_PATH_PATTERN.test(entry)
}

export function forEachSparseDirectoryInputLine(
  value: string,
  visit: (entry: string) => boolean | void
): void {
  let lineStart = 0
  for (let index = 0; index <= value.length; index += 1) {
    if (index < value.length && value.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && value.charCodeAt(index - 1) === 13 ? index - 1 : index
    if (visit(value.slice(lineStart, lineEnd)) === false) {
      return
    }
    lineStart = index + 1
  }
}

/** Normalize/deduplicate sparse directories while preserving input order for textarea round-tripping. */
export function normalizeSparseDirectoryLines(value: string): string[] {
  const seen = new Set<string>()
  const directories: string[] = []
  forEachSparseDirectoryInputLine(value, (rawEntry) => {
    const entry = rawEntry
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
    if (entry.length === 0 || seen.has(entry)) {
      return
    }
    seen.add(entry)
    directories.push(entry)
  })
  return directories
}

export function hasSparseDirectoryParentSegment(entry: string): boolean {
  let segmentStart = 0
  for (let index = 0; index <= entry.length; index += 1) {
    if (index < entry.length && entry[index] !== '/') {
      continue
    }
    if (entry.slice(segmentStart, index) === '..') {
      return true
    }
    segmentStart = index + 1
  }
  return false
}

/** Compare directory sets independent of order so reordered textarea lines still match saved presets. */
export function sparseDirectoriesMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const set = new Set(left)
  return right.every((entry) => set.has(entry))
}
