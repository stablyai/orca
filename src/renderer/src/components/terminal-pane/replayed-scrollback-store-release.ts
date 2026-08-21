import {
  shouldPreserveTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../../shared/workspace-session-terminal-buffers'

type ReplayedScrollbackReleaseArgs = {
  hasScrollbackRefs: boolean
  worktreeId: string | undefined
  repos: readonly RepoConnection[]
}

/** Whether a replayed pane may drop its store-held scrollback copy now that xterm owns the bytes.
 *  Inverse of the force-park capture guard: keep the copy only where nothing can re-create it. */
export function canReleaseReplayedScrollbackFromStore({
  hasScrollbackRefs,
  worktreeId,
  repos
}: ReplayedScrollbackReleaseArgs): boolean {
  // Refs re-hydrate from disk and remote/SSH worktrees re-serialize at the next park; a local
  // worktree never re-mints its copy (includeLocalBuffers:false), so releasing it would lose it.
  return hasScrollbackRefs || shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)
}
