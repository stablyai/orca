// Why this lives apart from the <img>: Chromium only emits `page-favicon-updated` when a document's
// icon URL list *changes*, so both the chrome that renders an icon and the guest listeners that
// decide when to drop one have to agree on what counts as a usable icon and as a new site.

export function displayableFaviconUrl(faviconUrl: string | null | undefined): string | null {
  const trimmed = faviconUrl?.trim()
  if (!trimmed) {
    return null
  }
  // Why not a plain `data:` check: Chromium reports `data:,` for a page that declares no icon.
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

export function pickDisplayableFaviconUrl(favicons: readonly string[] | undefined): string | null {
  // Why not favicons[0]: the first entry can be a `data:,` sentinel or a non-web scheme while a
  // later entry is a real icon.
  for (const candidate of favicons ?? []) {
    const displayable = displayableFaviconUrl(candidate)
    if (displayable) {
      return displayable
    }
  }
  return null
}

function faviconOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null
  }
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

// Why the two sides are treated asymmetrically: a destination with no icon of its own (about:blank,
// file://, a doc preview) must drop the previous site's icon, but an unknown *origin* — a freshly
// attached guest that hasn't committed a document yet — is not evidence the icon is stale, and
// clearing there would strand a restored tab on the globe until its first paint.
export function browserNavigationLeavesFaviconOrigin(
  fromUrl: string | null | undefined,
  toUrl: string | null | undefined
): boolean {
  const to = faviconOrigin(toUrl)
  if (to === null) {
    return true
  }
  const from = faviconOrigin(fromUrl)
  if (from === null) {
    return false
  }
  return from !== to
}
