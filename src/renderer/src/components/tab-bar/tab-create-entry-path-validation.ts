function hasPathSeparator(query: string): boolean {
  return /[\\/]/.test(query)
}

function hasFilenameExtension(query: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.[^\\/]+$/.test(query.trim())
}

export function isLikelyNewFileIntent(query: string): boolean {
  return hasPathSeparator(query) || hasFilenameExtension(query)
}

export function validateNewTabEntryRelativePath(query: string): string {
  // Keep tab-created paths workspace-relative and unambiguous across platforms.
  // Absolute, home-relative, traversal, and UNC variants are handled elsewhere.
  const trimmed = query.trim()
  if (!trimmed) {
    throw new Error('Enter a URL or file path.')
  }
  if (Array.from(trimmed).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('File paths cannot contain control characters.')
  }
  if (trimmed.startsWith('/')) {
    throw new Error('Enter a relative file path.')
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    throw new Error('Windows drive paths are not supported here.')
  }
  if (/^[\\/]{2}/.test(trimmed)) {
    throw new Error('UNC paths are not supported here.')
  }
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    throw new Error('Home-relative paths are not supported here.')
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error('Enter a file path, not a directory path.')
  }
  if (trimmed.split(/[\\/]/).some((segment) => segment.length === 0)) {
    throw new Error('File paths cannot contain empty segments.')
  }

  const normalized = trimmed.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('File paths cannot contain . or .. segments.')
  }
  if (segments.some((segment) => segment === '~')) {
    throw new Error('File paths cannot contain ~ segments.')
  }
  return normalized
}
