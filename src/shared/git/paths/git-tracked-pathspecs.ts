function normalizeGitPathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function createTrackedPathSpecMatcher(
  trackedPaths: readonly string[]
): (filePath: string) => boolean {
  // Normalize lazily so selecting a directory still stops at its first tracked descendant.
  const normalizedTrackedPaths: string[] = []
  return (filePath) => {
    const normalized = normalizeGitPathForCompare(filePath)
    const descendantPrefix = `${normalized}/`
    return trackedPaths.some((trackedPath, index) => {
      const normalizedTracked = (normalizedTrackedPaths[index] ??=
        normalizeGitPathForCompare(trackedPath))
      return normalizedTracked === normalized || normalizedTracked.startsWith(descendantPrefix)
    })
  }
}

export function isTrackedPathSpec(filePath: string, trackedPaths: readonly string[]): boolean {
  return createTrackedPathSpecMatcher(trackedPaths)(filePath)
}

export function partitionTrackedPathSpecs(
  filePaths: readonly string[],
  trackedPathSpecs: readonly string[]
): { trackedPaths: string[]; untrackedPaths: string[] } {
  const isTracked = createTrackedPathSpecMatcher(trackedPathSpecs)
  const trackedPaths: string[] = []
  const untrackedPaths: string[] = []
  // Keep original spellings, duplicates and order: these arrays select restore versus clean.
  for (const filePath of filePaths) {
    ;(isTracked(filePath) ? trackedPaths : untrackedPaths).push(filePath)
  }
  return { trackedPaths, untrackedPaths }
}
