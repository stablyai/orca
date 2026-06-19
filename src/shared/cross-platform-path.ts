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

export function isRuntimePathAbsolute(
  value: string,
  pathFlavor: 'posix' | 'windows' = isWindowsPathFlavor(value) ? 'windows' : 'posix'
): boolean {
  if (pathFlavor === 'windows') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\') || value.startsWith('/')
  }
  return value.startsWith('/')
}

export function resolveRuntimePath(basePath: string, targetPath: string): string {
  const pathFlavor =
    isWindowsPathFlavor(basePath) || isWindowsPathFlavor(targetPath) ? 'windows' : 'posix'
  if (isRuntimePathAbsolute(targetPath, pathFlavor)) {
    return normalizeRuntimePathDots(targetPath, pathFlavor)
  }
  return normalizeRuntimePathDots(
    `${trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(basePath))}/${targetPath}`,
    pathFlavor
  )
}

export function getRuntimePathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/g, '')
  if (!trimmed) {
    return ''
  }
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
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

function isWindowsPathFlavor(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || value.startsWith('//')
}

function normalizeRuntimePathDots(value: string, pathFlavor: 'posix' | 'windows'): string {
  const normalized = normalizeRuntimePathSeparators(value)
  const { root, rest } = splitRuntimePathRoot(normalized, pathFlavor)
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!root) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }
  const suffix = segments.join('/')
  if (!root) {
    return suffix || '.'
  }
  return suffix ? `${root}${suffix}` : trimRuntimePathTrailingSlash(root)
}

function splitRuntimePathRoot(
  value: string,
  pathFlavor: 'posix' | 'windows'
): { root: string; rest: string } {
  if (pathFlavor === 'windows') {
    const drive = value.match(/^([A-Za-z]:)(?:\/|$)/)
    if (drive) {
      return { root: `${drive[1]}/`, rest: value.slice(drive[0].length) }
    }
    if (value.startsWith('//')) {
      const parts = value.slice(2).split('/')
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const root = `//${parts[0]}/${parts[1]}/`
        return { root, rest: parts.slice(2).join('/') }
      }
      return { root: '//', rest: value.slice(2) }
    }
    if (value.startsWith('/')) {
      return { root: '/', rest: value.slice(1) }
    }
  }
  if (value.startsWith('/')) {
    return { root: '/', rest: value.slice(1) }
  }
  return { root: '', rest: value }
}
