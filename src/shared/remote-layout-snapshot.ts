import type { RuntimeMobileSessionTabsResult } from './runtime-session-contracts'

/** A workspace as last drawn: one-shot commands and retirement proofs (sent as deltas) are not kept. */
export type RemoteLayoutSnapshotWorkspace = Omit<
  RuntimeMobileSessionTabsResult,
  'navigationIntent' | 'retiredTerminalSurfaces'
>

/** Persist paired server’s last display-only layout so offline restarts retain tabs (design 6.3/D3). Never edit or send it back. */
export type RemoteLayoutSnapshot = {
  /** Keyed by worktree id, each from the server's last `session.tabs` result for it. */
  workspaces: Record<string, RemoteLayoutSnapshotWorkspace>
}
