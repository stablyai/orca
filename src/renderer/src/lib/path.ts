function stripTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function stripLeadingSeparators(path: string): string {
  return path.replace(/^[\\/]+/, '')
}

function getSeparator(path: string): '/' | '\\' {
  return path.includes('\\') ? '\\' : '/'
}

export function normalizeRelativePath(path: string): string {
  return stripLeadingSeparators(path).replace(/[\\/]+/g, '/')
}

function normalizeAbsolutePath(path: string): string {
  const isUncPath = /^[\\/]{2}[^\\/]/.test(path)
  const normalized = path.replace(/[\\/]+/g, '/')
  return isUncPath && !normalized.startsWith('//') ? `/${normalized}` : normalized
}

function stripTrailingAbsoluteSeparators(path: string): string {
  if (path === '/') {
    return path
  }
  if (/^[A-Za-z]:\/$/.test(path)) {
    return path
  }
  return path.replace(/\/+$/, '')
}

function isCaseInsensitiveAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:(?:\/|$)/.test(path) || path.startsWith('//')
}

export function getRelativePathInsideRoot(
  filePath: string,
  rootPath: string | null
): string | null {
  if (!rootPath) {
    return null
  }

  const normalizedFilePath = normalizeAbsolutePath(filePath)
  const normalizedRoot = stripTrailingAbsoluteSeparators(normalizeAbsolutePath(rootPath))
  const comparisonFilePath = isCaseInsensitiveAbsolutePath(normalizedFilePath)
    ? normalizedFilePath.toLowerCase()
    : normalizedFilePath
  const comparisonRoot = isCaseInsensitiveAbsolutePath(normalizedRoot)
    ? normalizedRoot.toLowerCase()
    : normalizedRoot

  if (comparisonFilePath === comparisonRoot) {
    return ''
  }

  // Why: POSIX and Windows drive roots already include their trailing separator.
  const isRootPath = normalizedRoot === '/' || /^[A-Za-z]:\/$/.test(normalizedRoot)
  const rootPrefix = isRootPath ? comparisonRoot : `${comparisonRoot}/`
  if (!comparisonFilePath.startsWith(rootPrefix)) {
    return null
  }

  const sliceStart = isRootPath ? normalizedRoot.length : normalizedRoot.length + 1
  return normalizeRelativePath(normalizedFilePath.slice(sliceStart))
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

  const separator = getSeparator(basePath)
  const normalizedBasePath = stripTrailingSeparators(basePath)
  const normalizedRelativePath = stripLeadingSeparators(relativePath).replace(/[\\/]+/g, separator)

  return `${normalizedBasePath}${separator}${normalizedRelativePath}`
}
