/**
 * What a collab whiteboard is attached to.
 *
 * One `CollabCanvas` component serves two surfaces that differ only in this
 * binding, and keeping the difference in one discriminated union is what stops
 * the permanent board and the session board from forking into two features:
 *
 * - `panel`  — a `PinnedCanvasPanel` in the User Panels sidebar. Persistent.
 *              Owns its own spawned omp agent, whose session rotates for fresh
 *              context and which the operator can reset or close by hand.
 * - `session` — a tab inside a worktree, opened beside the terminal. Ephemeral.
 *              Borrows the agent already running in that session's terminal —
 *              it never spawns one, so there is nothing to rotate or close.
 *
 * Both are multiplayer: the document lives in a node-a sync room keyed by
 * `boardId`, so the same board is live on the desktop and the tablet at once.
 * The binding decides the *agent*, never the *document transport*.
 */
export type CollabCanvasBinding =
  | {
      kind: 'panel'
      /** `PinnedCanvasPanel.id` — the sidebar entry. */
      panelId: string
      /** `PinnedCanvasPanel.boardId` — keys the snapshot + omp session dir. */
      boardId: string
    }
  | {
      kind: 'session'
      /** The workspace this board lives and dies with. */
      worktreeId: string
      /** Keys the snapshot only; the agent thread belongs to the terminal. */
      boardId: string
    }

/** The sync room a board's document lives in.
 *
 *  Boards are multiplayer: the authoritative document lives in the self-hosted
 *  tldraw sync server on node-a (`@tldraw/sync-core` + `SQLiteSyncStorage`),
 *  NOT in a per-host snapshot file. That is what lets the operator draw on the
 *  tablet mid-session and watch it land on the desktop — the two clients join
 *  the same room rather than handing a file back and forth.
 *
 *  Never Cloudflare: tldraw's own template uses Durable Objects + R2, and the
 *  mesh runs free, private and local. */
export function collabCanvasRoomUri(syncOrigin: string, boardId: string): string {
  // Why the room is keyed by boardId and not by the panel/tab id: a board keeps
  // one document across every surface that opens it (desktop tab, User Panel
  // tile, tablet route), and those all carry different surface ids.
  return `${syncOrigin.replace(/\/+$/, '')}/connect/${encodeURIComponent(boardId)}`
}

/** Where a board's exported tldraw snapshot is written on the owner's host.
 *  Export only — this is a deliberate "save a copy", NOT the persistence
 *  mechanism (see `collabCanvasRoomUri`). `$HOME` stays literal: the path is
 *  resolved in the pty shell on the worktree's owner host, which is the only
 *  host that resolves it correctly for an SSH/remote worktree (same rule as
 *  `buildPetOmpAgentArgs`). */
export function collabCanvasExportPath(boardId: string): string {
  return `$HOME/.local/state/meshina/collab-canvas/${boardId}.json`
}

/** The omp `--session-dir` for a panel board's bound agent. Session boards do
 *  not get one — they inject into a terminal that already owns a thread. */
export function collabCanvasSessionDirName(binding: CollabCanvasBinding): string | null {
  return binding.kind === 'panel' ? `canvas-${binding.boardId}` : null
}

/** Whether this surface owns (and may therefore reset or close) an agent
 *  thread. Drives which right-click rows a board offers: only a panel board
 *  shows "Fresh session" / "Close session", because closing a session board's
 *  agent would kill the operator's actual working terminal. */
export function collabCanvasOwnsAgentSession(binding: CollabCanvasBinding): boolean {
  return binding.kind === 'panel'
}

/** Build a session-bound board attachment for a workspace tab.
 *
 *  `entityId` on the tab IS the boardId. Do not hand-build this object at call
 *  sites — keep the shape in one place so panel vs session cannot drift.
 */
export function sessionCollabCanvasBinding(
  worktreeId: string,
  boardId: string
): Extract<CollabCanvasBinding, { kind: 'session' }> {
  return { kind: 'session', worktreeId, boardId }
}
