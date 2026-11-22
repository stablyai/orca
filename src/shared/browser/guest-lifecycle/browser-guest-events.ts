import type { BrowserExtensionContextMenuPayload } from '../extensions/browser-extension-context-menu-types'

export type BrowserPermissionDeniedEvent = {
  browserPageId: string
  /** Electron permission string (e.g. "media", "notifications"). */
  permission: string
  /** Sanitized to origin/host so auth query params never leak into UI state. */
  origin: string
}

/**
 * The last main-frame request step Orca saw for an uncommitted load: none (`no-request-seen`),
 * inside Orca's own request checks (`held`), or handed on to the network (`sent`), where it waits
 * for a socket, a connection or the server's response. Without a header listener, `held` can't
 * tell whether the request already went on. `unobserved`: the session had no page-request listener
 * when the load started, so no step could be seen.
 */
export type BrowserLoadStallPhase = 'unobserved' | 'no-request-seen' | 'held' | 'sent'

export type BrowserLoadStall = {
  phase: BrowserLoadStallPhase
  /** host[:port] only, so paths and queries never reach UI state. */
  host: string
  /** Same-profile pages on this scheme, host and port that the user isn't looking at. */
  hiddenSameOriginPages: number
}

export type BrowserLoadStallEvent = {
  browserPageId: string
  /** The guest that stalled; a clear from a replaced guest must not clear its successor's stall. */
  webContentsId: number
  /** Null once the load commits, fails, stops or is replaced. The phase and tab count stay in the trace. */
  stall: Pick<BrowserLoadStall, 'host'> | null
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
  /** Null unless the click landed in an editable field. */
  editable: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
    spelling: ContextMenuSpelling
  } | null
  /** Null unless the click landed on an image. `url` is the raw src, which may be data: or blob:. */
  image: { url: string; canCopy: boolean } | null
  /** Browser-extension items for this right-click (local extension profiles only). */
  extensionMenu?: BrowserExtensionContextMenuPayload
}

export type ContextMenuSpelling = {
  suggestions: string[]
  /** Empty when the word under the cursor is spelled correctly. */
  misspelledWord: string
}

export type BrowserContextMenuDismissedEvent = {
  browserPageId: string
}

export type BrowserTargetUrlChangedEvent = {
  browserPageId: string
  /** Link under the pointer or keyboard focus; empty when it leaves the link. */
  url: string
  screenX: number
  screenY: number
}
