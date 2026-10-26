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
