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
