import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'

export { normalizeRelativePath } from '../../../shared/cross-platform-path'

function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function stripLeadingSeparators(path: string): string {
  return path.replace(/^[\\/]+/, '')
}

function getSeparator(path: string): '/' | '\\' {
  return path.includes('\\') ? '\\' : '/'
}

export function getRelativePathInsideRoot(
  filePath: string,
  rootPath: string | null
): string | null {
  if (!rootPath) {
    return null
  }
  // Share Unicode containment folding; local case-only copies missed NFD/NFC matches (#10832).
  return relativePathInsideRoot(rootPath, filePath)
}

export function basename(path: string): string {
  const normalizedPath = stripTrailingSeparators(path)
  const lastSeparatorIndex = Math.max(
    normalizedPath.lastIndexOf('/'),
    normalizedPath.lastIndexOf('\\')
  )

  return lastSeparatorIndex === -1 ? normalizedPath : normalizedPath.slice(lastSeparatorIndex + 1)
}

export function dirname(path: string): string {
  const normalizedPath = stripTrailingSeparators(path)

  if (!normalizedPath) {
    return getSeparator(path)
  }

  if (/^[A-Za-z]:$/.test(normalizedPath)) {
    return normalizedPath
  }

  const lastSeparatorIndex = Math.max(
    normalizedPath.lastIndexOf('/'),
    normalizedPath.lastIndexOf('\\')
  )

  if (lastSeparatorIndex === -1) {
    return '.'
  }

  if (lastSeparatorIndex === 0) {
    return normalizedPath[0]
  }

  return normalizedPath.slice(0, lastSeparatorIndex)
}

export function joinPath(basePath: string, relativePath: string): string {
  if (!basePath) {
    return relativePath
  }

  if (!relativePath) {
    return basePath
  }

  const windowsPath = isWindowsAbsolutePathLike(basePath)
  const separator = windowsPath ? getSeparator(basePath) : '/'
  const normalizedBasePath = windowsPath
    ? stripTrailingSeparators(basePath)
    : basePath.replace(/\/+$/, '')
  const normalizedRelativePath = windowsPath
    ? stripLeadingSeparators(relativePath).replace(/[\\/]+/g, separator)
    : relativePath.replace(/^\/+/, '').replace(/\/+/g, '/')

  return `${normalizedBasePath}${separator}${normalizedRelativePath}`
}
