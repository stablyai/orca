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
  // Local worktrees never recapture buffers at park, so retain their stored copy; refs reload from disk and remote/SSH worktrees recapture.
  return hasScrollbackRefs || shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)
}
