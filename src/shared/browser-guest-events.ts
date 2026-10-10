export type BrowserPermissionDeniedEvent = {
  browserPageId: string
  /** Electron permission string (e.g. "media", "notifications"). */
  permission: string
  /** Sanitized to origin/host so auth query params never leak into UI state. */
  origin: string
}

export type BrowserPopupEvent = {
  browserPageId: string
  /** Sanitized to origin/host so auth query params never leak into UI state. */
  origin: string
  /** Whether Orca opened the target in Orca, opened it externally, or blocked it as unsafe. */
  action: 'opened-in-orca' | 'opened-external' | 'blocked'
}

export type BrowserDownloadRequestedEvent = {
  browserPageId: string
  downloadId: string
  /** Sanitized to origin/host so auth query params never leak into UI state. */
  origin: string
  filename: string
  totalBytes: number | null
  mimeType: string | null
  savePath: string
  status: 'downloading'
}

export type BrowserDownloadProgressEvent = {
  browserPageId?: string
  downloadId: string
  receivedBytes: number
  totalBytes: number | null
  state: 'progressing' | 'interrupted' | null
}

export type BrowserDownloadFinishedEvent = {
  browserPageId?: string
  downloadId: string
  status: 'completed' | 'canceled' | 'failed'
  savePath: string | null
  /** Present only when a client-hosted page's download was written to the remote workspace instead. */
  remoteDestination?: { workspaceRelativePath: string; hostLabel: string }
  /** Human-readable UI copy only; must never contain secrets. */
  error: string | null
}

export type BrowserContextMenuRequestedEvent = {
  browserPageId: string
  x: number
  y: number
  screenX: number
  screenY: number
  pageUrl: string
  linkUrl: string | null
  selectionText: string
  canGoBack: boolean
  canGoForward: boolean
  /** Entries the page's Chrome extensions add; absent from hosts without extension support. */
  extensionMenuItems?: BrowserExtensionMenuItem[]
}

/** A chrome.contextMenus entry; `index` names it when the renderer asks main to run it. */
export type BrowserExtensionMenuItem = {
  index: number
  label: string
  enabled: boolean
  hasSubmenu: boolean
  iconDataUrl: string | null
}

/** An extension's popup shortcut was pressed in the page whose guest WebContents id is tabId. */
export type BrowserExtensionActionRequestedEvent = {
  tabId: number
  extensionId: string
}

/** An extension's toolbar button as it shows for one page. */
export type BrowserExtensionAction = {
  extensionId: string
  name: string
  title: string
  iconDataUrl: string | null
  badgeText: string
  /** CSS colors; null keeps the toolbar's own badge colors. */
  badgeBackgroundColor: string | null
  badgeTextColor: string | null
  enabled: boolean
}

/** An installed extension as the browser settings list it. */
export type BrowserInstalledExtension = {
  id: string
  name: string
  version: string
  description: string
  iconDataUrl: string | null
  enabled: boolean
  hasOptions: boolean
}

/** A toolbar button's rectangle in its window's content coordinates, to anchor the popup. */
export type BrowserExtensionActionAnchor = { x: number; y: number; width: number; height: number }

export type BrowserContextMenuDismissedEvent = {
  browserPageId: string
}
