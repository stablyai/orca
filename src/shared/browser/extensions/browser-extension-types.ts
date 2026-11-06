/** How an extension reached this machine; store installs own their folder, unpacked ones never do. */
export type BrowserExtensionSource = 'webstore' | 'unpacked'

/** One installed extension, shared by every local browser profile that enables it. */
export type InstalledBrowserExtension = {
  id: string
  name: string
  version: string
  /** Store installs: `<userData>/browser-extensions/<id>/<version>`; unpacked: the user's folder (loaded from Orca's copy). */
  path: string
  source: BrowserExtensionSource
  /** Stable install/update precedence; absent on records written by older versions. */
  installTime?: number
  /** Relative to `path`. */
  iconPath: string | null
  permissions: string[]
  hostPermissions: string[]
  /** Relative to the extension origin. */
  optionsPage: string | null
}

/** What Settings shows for one extension in one browser profile. */
export type BrowserExtensionListing = {
  id: string
  name: string
  version: string
  source: BrowserExtensionSource
  enabled: boolean
  /** Why data URL: the renderer CSP does not load chrome-extension: images. */
  iconDataUrl: string | null
  hasOptionsPage: boolean
  permissions: string[]
  /** Why the last load in this profile failed; null once a load succeeds. */
  loadError: string | null
  /** A store update held until the user allows the access it adds. */
  heldUpdateVersion: string | null
}

export type BrowserExtensionListResult = {
  /** False until Orca restarts with the experimental setting on. */
  active: boolean
  extensions: BrowserExtensionListing[]
}

export type BrowserExtensionActionResult = { ok: true } | { ok: false; error: string }

/** Main → trusted renderer: the installed list, a load error or a held update changed; Settings refetches. */
export const BROWSER_EXTENSIONS_CHANGED_CHANNEL = 'browserExtensions:changed'
