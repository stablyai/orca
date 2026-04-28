const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/

export function isAbsoluteSparseDirectoryPath(value: string): boolean {
  const entry = value.trim()
  return entry.startsWith('/') || entry.startsWith('\\') || WINDOWS_DRIVE_PATH_PATTERN.test(entry)
}

export function normalizeSparseDirectoryLines(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split('\n')
    .map((entry) =>
      entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
    )
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false
      }
      seen.add(entry)
      return true
    })
}

export function sparseDirectoriesMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const set = new Set(left)
  return right.every((entry) => set.has(entry))
}
