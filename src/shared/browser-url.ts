import { ORCA_BROWSER_BLANK_URL } from './constants'

const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:\/.*)?$/i

function normalizeLocalFileUrl(parsed: URL): string | null {
  // Why: the in-app browser needs to render local HTML files selected from the
  // file explorer, but only local disk paths should be admitted here. Reject
  // remote file hosts so `file://server/share` does not masquerade as a safe
  // local navigation target.
  if (parsed.hostname && parsed.hostname !== 'localhost') {
    return null
  }
  return parsed.toString()
}

export function normalizeBrowserNavigationUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0 || trimmed === 'about:blank' || trimmed === ORCA_BROWSER_BLANK_URL) {
    return ORCA_BROWSER_BLANK_URL
  }

  if (LOCAL_ADDRESS_PATTERN.test(trimmed)) {
    try {
      return new URL(`http://${trimmed}`).toString()
    } catch {
      return null
    }
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString()
    }
    if (parsed.protocol === 'file:') {
      return normalizeLocalFileUrl(parsed)
    }
    return null
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString()
    } catch {
      return null
    }
  }
}

export function normalizeExternalBrowserUrl(rawUrl: string): string | null {
  const normalized = normalizeBrowserNavigationUrl(rawUrl)
  if (normalized === ORCA_BROWSER_BLANK_URL || normalized?.startsWith('file:')) {
    return null
  }
  return normalized
}
