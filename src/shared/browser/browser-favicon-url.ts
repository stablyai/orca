import { isEligibleLocalCertificateHost, isWildcardBindHost } from '../browser-url'

// Chromium emits icon updates only when the URL list changes; rendering and navigation listeners must share origin/icon rules.

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
  // Skip sentinel/non-web entries even when a later favicon is usable.
  for (const candidate of favicons ?? []) {
    const displayable = displayableFaviconUrl(candidate)
    if (displayable) {
      return displayable
    }
  }
  return null
}

// Session-tab rows resend whole on every change, so a page's inline data: icon must not grow them.
const MAX_REMOTE_TAB_FAVICON_URL_LENGTH = 2048
// URL serializes [::ffff:127.0.0.1] as [::ffff:7f00:1].
const IPV4_MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i

/** The favicon a host publishes for a remote client, which loads it from its own network. */
export function remoteTabFaviconUrl(faviconUrl: string | null | undefined): string | null {
  const displayable = displayableFaviconUrl(faviconUrl)
  if (!displayable || displayable.length > MAX_REMOTE_TAB_FAVICON_URL_LENGTH) {
    return null
  }
  if (displayable.startsWith('data:')) {
    return displayable
  }
  // The host's loopback names a different machine on the client.
  const hostname = new URL(displayable).hostname
  return isWildcardBindHost(hostname) ||
    isEligibleLocalCertificateHost(hostname) ||
    IPV4_MAPPED_LOOPBACK.test(hostname)
    ? null
    : displayable
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

// Clear icons for non-site destinations, but keep restored icons when the attached guest’s origin is still unknown.
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
