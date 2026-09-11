/**
 * Host-local view of the browser pages a paired CLIENT desktop renders for one of this host's
 * workspaces. The page itself never exists on the host, so the host UI has no store tab for it —
 * these rows are the whole model, pushed over local IPC and held only in renderer memory.
 *
 * Nothing here crosses the runtime wire: paired clients learn about the same pages through the
 * session-tabs snapshot, which is a separate, already-negotiated payload.
 */
export type ClientHostedBrowserRow = {
  browserPageId: string
  worktreeId: string
  url: string
  title: string
  loading: boolean
  browserHostClientId: string
  /** Paired device display name, when the runtime still knows it; null for an unnamed host. */
  hostDeviceName: string | null
  /** The client that rendered this page is gone but the page was retained and can still be closed. */
  hostAbsent: boolean
}

export type ClientHostedBrowserRowsEvent = {
  worktreeId: string
  rows: ClientHostedBrowserRow[]
}
