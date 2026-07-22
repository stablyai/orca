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

/** Where a board's tldraw snapshot lives on the board owner's host. Kept
 *  beside the pet's omp session dirs so one state root covers mesh surfaces.
 *  `$HOME` stays literal: the path is resolved in the pty shell on the
 *  worktree's owner host, which is the only host that resolves it correctly
 *  for an SSH/remote worktree (same rule as `buildPetOmpAgentArgs`). */
export function collabCanvasSnapshotPath(boardId: string): string {
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
