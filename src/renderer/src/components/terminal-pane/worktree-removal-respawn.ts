// A workspace removal fences terminal spawns twice: main rejects pty:spawn with
// TerminalRemovalInProgressError, and the renderer skips its own doomed respawn
// while `isDeleting` is set. Both suppressions are one-shot — a pane's connect
// runs once — so a removal that FAILS after killing the shells strands the pane
// blank with nothing left to re-trigger a spawn. These helpers decide when that
// suppression has settled and the pane should try again.

export type WorktreeRemovalRespawnDecision =
  // A removal is still in flight; keep waiting.
  | 'wait'
  // Every removal settled and the workspace survived — the delete failed, so respawn.
  | 'respawn'
  // The workspace is gone; the pane is about to unmount, so stay quiet.
  | 'abandon'

// Why: bounds pathological arm→spawn→fence→arm cycles (e.g. a removal driven
// from the CLI or a paired client that the renderer store never observes).
export const MAX_WORKTREE_REMOVAL_RESPAWN_ATTEMPTS = 3

// Why: removals started outside this renderer never set `isDeleting`, so the
// store may never emit. Re-evaluate on a timer as well, long enough that a
// normal removal has either finished or failed first.
export const WORKTREE_REMOVAL_RESPAWN_FALLBACK_MS = 4_000

// Why: last resort when the retries above never got through. Mirrors
// terminal-zero-dimensions-diagnostic: a plain diagnostic string for the pane's
// error banner, so the user is never left with a blank pane and no explanation.
export const WORKTREE_REMOVAL_SPAWN_BLOCKED_MESSAGE =
  'This terminal could not start: a workspace deletion is still blocking new shells. Reopen this tab once the deletion finishes or is cancelled.'

// Why NOT getKnownWorktreeById: it falls back to `detectedWorktreesByRepo`, which
// is the repo's full on-disk worktree scan (registered rows carry `visible: true`)
// and which removeWorktree never prunes. A successfully deleted workspace stays
// resolvable there until the next detection refresh, so reading it would respawn a
// shell into the directory that was just deleted. Only consult the maps the
// removal clears in the same set() as the deletion.
export function isWorkspaceStillRegistered(
  state: {
    worktreesByRepo?: Record<string, readonly { id: string }[] | undefined>
    folderWorkspaces?: readonly { id: string }[]
  },
  workspaceId: string,
  folderWorkspaceId: string | null
): boolean {
  if (folderWorkspaceId !== null) {
    return (state.folderWorkspaces ?? []).some((workspace) => workspace.id === folderWorkspaceId)
  }
  return Object.values(state.worktreesByRepo ?? {}).some((worktrees) =>
    (worktrees ?? []).some((worktree) => worktree.id === workspaceId)
  )
}

export function resolveWorktreeRemovalRespawnDecision(
  deleteStateByWorktreeId: Record<string, { isDeleting?: boolean } | undefined> | undefined,
  worktreeExists: boolean
): WorktreeRemovalRespawnDecision {
  // Why: an overlapping parent/child root removal fences this pane too, and the
  // pane's own worktree has no delete state in that case — so wait on every
  // in-flight removal, not just this workspace's.
  for (const entry of Object.values(deleteStateByWorktreeId ?? {})) {
    if (entry?.isDeleting === true) {
      return 'wait'
    }
  }
  return worktreeExists ? 'respawn' : 'abandon'
}
