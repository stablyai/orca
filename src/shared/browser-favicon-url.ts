// Favicons render at icon scale; bound page-controlled data before it reaches session history.
export const MAX_PERSISTED_BROWSER_FAVICON_URL_LENGTH = 64 * 1024

export function normalizeBrowserFaviconUrl(faviconUrl: string | null | undefined): string | null {
  const trimmed = faviconUrl?.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('data:image/')) {
    return trimmed
  }
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

export function normalizePersistedBrowserFaviconUrl(
  faviconUrl: string | null | undefined
): string | null {
  const normalized = normalizeBrowserFaviconUrl(faviconUrl)
  return normalized && normalized.length <= MAX_PERSISTED_BROWSER_FAVICON_URL_LENGTH
    ? normalized
    : null
}

export function firstBrowserFaviconUrl(favicons: readonly string[] | undefined): string | null {
  for (const favicon of favicons ?? []) {
    const normalized = normalizeBrowserFaviconUrl(favicon)
    if (normalized) {
      return normalized
    }
  }
  return null
}

function browserOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export function browserNavigationChangesFaviconOrigin(
  currentUrl: string | null,
  destinationUrl: string
): boolean {
  const destinationOrigin = browserOrigin(destinationUrl)
  if (!destinationOrigin) {
    return true
  }
  return currentUrl ? browserOrigin(currentUrl) !== destinationOrigin : false
}
