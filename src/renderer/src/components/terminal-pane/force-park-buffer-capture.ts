import {
  shouldPreserveTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../../shared/workspace-session-terminal-buffers'
import { captureTerminalShutdownBuffersBestEffort } from './shutdown-buffer-captures'

type ForceParkedWorktreeCaptureArgs = {
  worktreeId: string
  tabIds: readonly string[]
  repos: readonly RepoConnection[]
}

/** Serialize a force-parked worktree's panes before eviction unmounts them.
 *  Returns whether the episode covered every tab; false leaves it unmarked so a later episode retries. */
export function captureForceParkedWorktreeBuffers({
  worktreeId,
  tabIds,
  repos
}: ForceParkedWorktreeCaptureArgs): boolean {
  // Why skip local worktrees: includeLocalBuffers:false serializes nothing for them, so the only
  // effect left is setTabLayout replacing away a stored buffer (e.g. an exited setup pane's output).
  if (!shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)) {
    return true
  }
  const { requested, captured } = captureTerminalShutdownBuffersBestEffort(tabIds, {
    includeLocalBuffers: false,
    excludeRemoteRuntimeScrollback: true
  })
  return captured === requested
}
