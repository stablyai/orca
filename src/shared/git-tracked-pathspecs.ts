function normalizeGitPathForCompare(filePath: string, windowsPaths: boolean): string {
  // Backslashes are filename characters on POSIX execution hosts.
  const normalized = windowsPaths ? filePath.replace(/\\/g, '/') : filePath
  return normalized.replace(/\/+$/, '')
}

function createTrackedPathSpecMatcher(
  trackedPaths: readonly string[],
  windowsPaths: boolean
): (filePath: string) => boolean {
  // Normalize lazily so selecting a directory still stops at its first tracked descendant.
  const normalizedTrackedPaths: string[] = []
  return (filePath) => {
    const normalized = normalizeGitPathForCompare(filePath, windowsPaths)
    const descendantPrefix = `${normalized}/`
    return trackedPaths.some((trackedPath, index) => {
      const normalizedTracked = (normalizedTrackedPaths[index] ??= normalizeGitPathForCompare(
        trackedPath,
        windowsPaths
      ))
      return normalizedTracked === normalized || normalizedTracked.startsWith(descendantPrefix)
    })
  }
}

export function partitionTrackedPathSpecs(
  filePaths: readonly string[],
  trackedPathSpecs: readonly string[],
  windowsPaths: boolean
): { trackedPaths: string[]; untrackedPaths: string[] } {
  const isTracked = createTrackedPathSpecMatcher(trackedPathSpecs, windowsPaths)
  const trackedPaths: string[] = []
  const untrackedPaths: string[] = []
  // Keep original spellings, duplicates and order: these arrays select restore versus clean.
  for (const filePath of filePaths) {
    ;(isTracked(filePath) ? trackedPaths : untrackedPaths).push(filePath)
  }
  return { trackedPaths, untrackedPaths }
}
