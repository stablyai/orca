import { isChromeExtensionId } from './browser-extension-url'

/** Exact origin only: a prefix match would hand install rights to look-alike hosts. */
export const CHROME_WEB_STORE_ORIGIN = 'https://chromewebstore.google.com'
export const CHROME_WEB_STORE_HOME_URL = `${CHROME_WEB_STORE_ORIGIN}/`

/** Store page → main. Payload: { method, args }; reply: ChromeWebStoreReply. */
export const BROWSER_EXTENSION_WEB_STORE_CHANNEL = 'browserExtension:webStore'
/** Main → store page top frame. Payload: { event, args } for management.onInstalled/onUninstalled. */
export const BROWSER_EXTENSION_WEB_STORE_EVENT_CHANNEL = 'browserExtension:webStoreEvent'

/** `value` reaches the page callback; `error` becomes chrome.runtime.lastError around it. */
export type ChromeWebStoreReply = { value?: unknown; error?: string }

export function isChromeWebStoreUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === CHROME_WEB_STORE_ORIGIN
  } catch {
    return false
  }
}

const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com'])

/** A store detail link (current or legacy host) or a bare extension id → the id, else null. */
export function parseChromeWebStoreExtensionInput(input: string): string | null {
  const trimmed = input.trim()
  if (isChromeExtensionId(trimmed.toLowerCase())) {
    return trimmed.toLowerCase()
  }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !STORE_HOSTS.has(url.hostname) || url.username || url.port) {
    return null
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const detailIndex = segments.indexOf('detail')
  if (detailIndex === -1) {
    return null
  }
  // `/detail/<slug>/<id>` or `/detail/<id>`; legacy adds a `/webstore` prefix.
  const candidates = segments.slice(detailIndex + 1, detailIndex + 3)
  return candidates.find((segment) => isChromeExtensionId(segment)) ?? null
}

/** Main → trusted renderer: show / close Orca's install confirmation. */
export const BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL =
  'browserExtensions:installPromptRequested'
export const BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL =
  'browserExtensions:installPromptClosed'

/** Orca's own install/uninstall confirmation, shown by the trusted renderer. */
export type BrowserExtensionInstallPromptRequest = {
  requestId: string
  /** `permissions`: an installed extension's permissions.request for optional access. */
  kind: 'install' | 'uninstall' | 'permissions'
  name: string
  iconDataUrl: string | null
  /** API permissions as the manifest names them; the renderer turns them into plain language. */
  permissions: string[]
  /** Host patterns from host_permissions, MV2 permissions and content script matches. */
  hostPermissions: string[]
  /** Browser profile the extension is turned on in, for install prompts. */
  profileLabel: string | null
}

export type BrowserExtensionInstallPromptResponse = { requestId: string; accepted: boolean }

export type BrowserExtensionWebStoreInstallResult =
  | { status: 'installed'; name: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }
