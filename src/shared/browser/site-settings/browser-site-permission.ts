/** What a site in the built-in browser can ask for, in the order prompts and settings list them. */
export const BROWSER_SITE_PERMISSIONS = [
  'camera',
  'microphone',
  'location',
  'notifications',
  'clipboard',
  'midi',
  'window-management',
  'idle-detection',
  'local-network'
] as const

export type BrowserSitePermission = (typeof BROWSER_SITE_PERMISSIONS)[number]

/** Every local file shares one site, as in Chrome; a file page's web origin is opaque. */
export const BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN = 'file://'

/** A remembered answer; a permission with none is asked again. */
export type BrowserSitePermissionDecision = 'allow' | 'block'

/** Lets a site open links of one scheme in another app without asking; only ever allowed. */
export type BrowserExternalAppPermission = `external-app:${string}`

/** Everything remembered per site: the permissions above, and apps it may open. */
export type BrowserSitePermissionKey = BrowserSitePermission | BrowserExternalAppPermission

const EXTERNAL_APP_PERMISSION_PREFIX = 'external-app:'
// URL scheme syntax (RFC 3986), lowercased as WHATWG URL reports it.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*$/

export function browserExternalAppPermission(scheme: string): BrowserExternalAppPermission {
  return `${EXTERNAL_APP_PERMISSION_PREFIX}${scheme}`
}

export function browserExternalAppPermissionScheme(
  permission: BrowserExternalAppPermission
): string {
  return permission.slice(EXTERNAL_APP_PERMISSION_PREFIX.length)
}

export function isBrowserExternalAppPermission(
  value: unknown
): value is BrowserExternalAppPermission {
  return (
    typeof value === 'string' &&
    value.startsWith(EXTERNAL_APP_PERMISSION_PREFIX) &&
    URL_SCHEME_RE.test(value.slice(EXTERNAL_APP_PERMISSION_PREFIX.length))
  )
}

/** A site asks for one or more permissions at once, e.g. camera and microphone for a call. */
export type BrowserSitePermissionPrompt = {
  /** Origin of the page in the tab, e.g. `https://meet.google.com`. */
  origin: string
  permissions: BrowserSitePermission[]
}

/** Every remembered answer for one site in one browser profile. */
export type BrowserSitePermissionEntry = {
  origin: string
  decisions: Partial<Record<BrowserSitePermissionKey, BrowserSitePermissionDecision>>
}

export function isBrowserSitePermission(value: unknown): value is BrowserSitePermission {
  return BROWSER_SITE_PERMISSIONS.some((permission) => permission === value)
}

export function isBrowserSitePermissionDecision(
  value: unknown
): value is BrowserSitePermissionDecision {
  return value === 'allow' || value === 'block'
}

export function isBrowserSitePermissionKey(value: unknown): value is BrowserSitePermissionKey {
  return isBrowserSitePermission(value) || isBrowserExternalAppPermission(value)
}

/** External-app permissions are never blocked: Cancel already quiets a page that keeps asking. */
export function isValidBrowserSitePermissionDecision(
  permission: BrowserSitePermissionKey,
  decision: unknown
): decision is BrowserSitePermissionDecision {
  return isBrowserSitePermission(permission)
    ? isBrowserSitePermissionDecision(decision)
    : decision === 'allow'
}
