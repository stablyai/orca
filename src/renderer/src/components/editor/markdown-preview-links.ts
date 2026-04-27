function toFileUrl(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/')
  const segments = normalizedPath.split('/').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
      return segment
    }
    return encodeURIComponent(segment)
  })

  if (normalizedPath.startsWith('/')) {
    return `file://${segments.join('/')}`
  }

  return `file:///${segments.join('/')}`
}

export function resolveMarkdownPreviewHref(rawUrl: string, filePath: string): URL | null {
  if (!rawUrl || rawUrl.startsWith('#')) {
    return null
  }

  try {
    return new URL(rawUrl, toFileUrl(filePath))
  } catch {
    return null
  }
}

export function getMarkdownPreviewLinkTarget(
  rawHref: string | undefined,
  filePath: string
): string | null {
  if (!rawHref) {
    return null
  }

  const resolved = resolveMarkdownPreviewHref(rawHref, filePath)
  if (!resolved) {
    return null
  }

  if (
    resolved.protocol === 'http:' ||
    resolved.protocol === 'https:' ||
    resolved.protocol === 'file:'
  ) {
    return resolved.toString()
  }

  return null
}

export function getMarkdownPreviewImageSrc(
  rawSrc: string | undefined,
  filePath: string
): string | undefined {
  if (!rawSrc) {
    return rawSrc
  }

  const resolved = resolveMarkdownPreviewHref(rawSrc, filePath)
  if (!resolved) {
    return rawSrc
  }

  if (
    resolved.protocol === 'http:' ||
    resolved.protocol === 'https:' ||
    resolved.protocol === 'file:'
  ) {
    return resolved.toString()
  }

  return rawSrc
}

/**
 * Resolves a relative image src against the markdown file path to produce an
 * absolute filesystem path. Returns null for external URLs (http, https, data,
 * blob) that don't need local file loading.
 */
export function resolveImageAbsolutePath(
  rawSrc: string | undefined,
  filePath: string
): string | null {
  if (!rawSrc) {
    return null
  }

  const resolved = resolveMarkdownPreviewHref(rawSrc, filePath)
  if (!resolved || resolved.protocol !== 'file:') {
    return null
  }

  // Convert file:///path/to/file → /path/to/file (Unix)
  // Convert file:///C:/path/to/file → C:/path/to/file (Windows)
  let absolutePath = decodeURIComponent(resolved.pathname)
  if (/^\/[A-Za-z]:\//.test(absolutePath)) {
    absolutePath = absolutePath.slice(1)
  }

  return absolutePath
}

export function fileUrlToAbsolutePath(fileUrl: URL): string | null {
  if (fileUrl.protocol !== 'file:') {
    return null
  }

  let absolutePath = decodeURIComponent(fileUrl.pathname)
  if (/^\/[A-Za-z]:\//.test(absolutePath)) {
    absolutePath = absolutePath.slice(1)
  }

  return absolutePath
}
