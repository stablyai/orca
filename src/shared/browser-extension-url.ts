import { ORCA_BROWSER_BLANK_URL } from './constants'
import { normalizeBrowserNavigationUrl } from './browser-url'

const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/

export function isChromeExtensionId(value: unknown): value is string {
  return typeof value === 'string' && CHROME_EXTENSION_ID_PATTERN.test(value)
}

/** `chrome-extension://<id>/…` with a well-formed id, else null. */
export function parseChromeExtensionUrl(
  rawUrl: string
): { extensionId: string; url: string } | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'chrome-extension:' || !isChromeExtensionId(parsed.hostname)) {
      return null
    }
    return { extensionId: parsed.hostname, url: parsed.toString() }
  } catch {
    return null
  }
}

export function getChromeExtensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`
}

/** Why: an extension page may move between its own pages, never into another extension's. */
export function isSameExtensionNavigation(fromUrl: string, toUrl: string): boolean {
  const from = parseChromeExtensionUrl(fromUrl)
  const to = parseChromeExtensionUrl(toUrl)
  return from !== null && to !== null && from.extensionId === to.extensionId
}

/** Webview `src` admission in the renderer; main's attach check decides whether the extension is enabled. */
export function normalizeBrowserGuestSrc(rawUrl: string): string | null {
  return normalizeBrowserNavigationUrl(rawUrl) ?? parseChromeExtensionUrl(rawUrl)?.url ?? null
}

export type BrowserExtensionRequestedUrl =
  | { kind: 'blank'; url: string }
  | { kind: 'extension'; extensionId: string; url: string }
  | { kind: 'web'; url: string }

/**
 * Every URL an extension asks Orca to open goes through here. Relative URLs resolve against the
 * caller's own origin (Chrome semantics); everything else must pass Orca's typed-URL rules.
 */
export function resolveBrowserExtensionRequestedUrl(
  rawUrl: string | undefined,
  callerExtensionId: string
): BrowserExtensionRequestedUrl | null {
  if (rawUrl === undefined || rawUrl.trim() === '' || rawUrl === 'about:blank') {
    return { kind: 'blank', url: ORCA_BROWSER_BLANK_URL }
  }
  let absolute: URL
  try {
    absolute = new URL(rawUrl.trim(), `${getChromeExtensionOrigin(callerExtensionId)}/`)
  } catch {
    return null
  }
  if (absolute.protocol === 'chrome-extension:') {
    const extensionUrl = parseChromeExtensionUrl(absolute.toString())
    return extensionUrl ? { kind: 'extension', ...extensionUrl } : null
  }
  // Why: file: is a user-initiated preview scheme in Orca; extensions never get to open local files.
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
    return null
  }
  const normalized = normalizeBrowserNavigationUrl(absolute.toString())
  return normalized ? { kind: 'web', url: normalized } : null
}
