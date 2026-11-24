/** Host-local IPC/memory rows represent pages rendered on paired clients, absent from host store tabs. Runtime clients receive separate negotiated session-tabs snapshots. */
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
