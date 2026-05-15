export function isWindowsAbsolutePathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//')
}

export function normalizeRuntimePathSeparators(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return `//${normalized.replace(/^\/+/, '')}`
  }
  return normalized
}

export function normalizeRuntimePathForComparison(value: string): string {
  const normalized = trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(value))
  return isWindowsAbsolutePathLike(value) ? normalized.toLowerCase() : normalized
}

export function isPathInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const root = normalizeRuntimePathForComparison(rootPath)
  const candidate = normalizeRuntimePathForComparison(candidatePath)
  if (candidate === root) {
    return true
  }
  const rootWithBoundary =
    root === '/' || /^[a-z]:\/$/i.test(root) ? root : `${root.replace(/\/+$/, '')}/`
  return candidate.startsWith(rootWithBoundary)
}

export function relativePathInsideRoot(rootPath: string, candidatePath: string): string | null {
  const normalizedRoot = trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(rootPath))
  const normalizedCandidate = trimRuntimePathTrailingSlash(
    normalizeRuntimePathSeparators(candidatePath)
  )
  const comparisonRoot = isWindowsAbsolutePathLike(rootPath)
    ? normalizedRoot.toLowerCase()
    : normalizedRoot
  const comparisonCandidate = isWindowsAbsolutePathLike(rootPath)
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate

  if (comparisonCandidate === comparisonRoot) {
    return ''
  }
  const isRoot = comparisonRoot === '/' || /^[a-z]:\/$/i.test(comparisonRoot)
  const comparisonPrefix = isRoot ? comparisonRoot : `${comparisonRoot}/`
  if (!comparisonCandidate.startsWith(comparisonPrefix)) {
    return null
  }
  return normalizedCandidate.slice(comparisonPrefix.length)
}

function trimRuntimePathTrailingSlash(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value
  }
  return value.replace(/\/+$/, '')
}
