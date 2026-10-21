import type { RuntimeMobileSessionTabsResult } from './runtime-session-contracts'

/** A workspace as last drawn: one-shot commands and retirement proofs (sent as deltas) are not kept. */
export type RemoteLayoutSnapshotWorkspace = Omit<
  RuntimeMobileSessionTabsResult,
  'navigationIntent' | 'retiredTerminalSurfaces'
>

/**
 * The last layout one paired server sent this desktop (design 6.3, D3), kept so a restart while
 * the server is offline can still draw its tabs. Display-only: never edited, never sent back.
 */
export type RemoteLayoutSnapshot = {
  /** Keyed by worktree id, each from the server's last `session.tabs` result for it. */
  workspaces: Record<string, RemoteLayoutSnapshotWorkspace>
}
