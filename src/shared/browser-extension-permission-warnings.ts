/**
 * Which access raises an install warning, after Chromium's permission messages. Main compares
 * warnings to decide whether an update must ask again; the renderer words them. Permissions with
 * no warning in Chrome (storage, alarms, offscreen, …) map to null.
 */

export type BrowserExtensionPermissionWarning =
  | 'history'
  | 'historyWrite'
  | 'bookmarks'
  | 'clipboardRead'
  | 'clipboardWrite'
  | 'downloads'
  | 'nativeMessaging'
  | 'notifications'
  | 'privacy'
  | 'management'
  | 'proxy'
  | 'contentSettings'
  | 'geolocation'
  | 'topSites'
  | 'blockContent'
  | 'debugger'
  | 'screenCapture'
  | 'email'

/** The access lists an install prompt and an update check work from. */
export type BrowserExtensionAccessLists = {
  permissions: string[]
  hostPermissions: string[]
}

export function browserExtensionPermissionWarning(
  permission: string
): BrowserExtensionPermissionWarning | null {
  switch (permission) {
    case 'tabs':
    case 'webNavigation':
      return 'history'
    case 'history':
      return 'historyWrite'
    case 'bookmarks':
    case 'clipboardRead':
    case 'clipboardWrite':
    case 'downloads':
    case 'nativeMessaging':
    case 'notifications':
    case 'privacy':
    case 'management':
    case 'proxy':
    case 'contentSettings':
    case 'geolocation':
    case 'topSites':
    case 'debugger':
      return permission
    case 'declarativeNetRequest':
      return 'blockContent'
    case 'desktopCapture':
    case 'tabCapture':
      return 'screenCapture'
    case 'identity.email':
      return 'email'
    default:
      return null
  }
}

/** `*://*.example.com/*` → `example.com`; null when the pattern covers every site. */
export function browserExtensionHostLabel(pattern: string): string | null {
  if (pattern === '<all_urls>') {
    return null
  }
  const host = /^[^:]+:\/\/([^/]*)/.exec(pattern)?.[1] ?? ''
  if (host === '*' || host === '') {
    return null
  }
  return host.replace(/^\*\./, '')
}

export type BrowserExtensionHostWarning =
  | { kind: 'allSites' }
  | { kind: 'sites'; hosts: string[] }
  | null

export function browserExtensionHostWarning(
  hostPermissions: string[]
): BrowserExtensionHostWarning {
  if (hostPermissions.length === 0) {
    return null
  }
  const labels = hostPermissions.map(browserExtensionHostLabel)
  if (labels.includes(null)) {
    return { kind: 'allSites' }
  }
  return {
    kind: 'sites',
    hosts: [...new Set(labels.filter((label): label is string => label !== null))]
  }
}

function permissionWarningCovered(
  warning: BrowserExtensionPermissionWarning,
  granted: ReadonlySet<BrowserExtensionPermissionWarning>
): boolean {
  // Why: Chrome folds "read history" into "read and change history".
  return granted.has(warning) || (warning === 'history' && granted.has('historyWrite'))
}

/**
 * The part of `candidate` whose warnings `granted` does not already show. Empty lists mean an
 * update can apply without asking, as Chrome does when its warning set does not grow.
 */
export function newBrowserExtensionWarnings(
  candidate: BrowserExtensionAccessLists,
  granted: BrowserExtensionAccessLists
): BrowserExtensionAccessLists {
  const grantedWarnings = new Set(
    granted.permissions.map(browserExtensionPermissionWarning).filter((warning) => warning !== null)
  )
  const permissions = candidate.permissions.filter((permission) => {
    const warning = browserExtensionPermissionWarning(permission)
    return warning !== null && !permissionWarningCovered(warning, grantedWarnings)
  })
  const grantedHosts = browserExtensionHostWarning(granted.hostPermissions)
  const hostPermissions =
    grantedHosts?.kind === 'allSites'
      ? []
      : candidate.hostPermissions.filter((pattern) => {
          const label = browserExtensionHostLabel(pattern)
          return label === null || !grantedHosts?.hosts.includes(label)
        })
  return { permissions, hostPermissions }
}

export function hasBrowserExtensionWarnings(access: BrowserExtensionAccessLists): boolean {
  return access.permissions.length > 0 || access.hostPermissions.length > 0
}
