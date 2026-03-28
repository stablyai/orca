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

function resolveMarkdownUrl(rawUrl: string, filePath: string): URL | null {
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

  const resolved = resolveMarkdownUrl(rawHref, filePath)
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

  const resolved = resolveMarkdownUrl(rawSrc, filePath)
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
