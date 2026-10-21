import {
  shouldPreserveTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../../shared/workspace-session-terminal-buffers'
import { captureTerminalShutdownBuffersBestEffort } from './shutdown-buffer-captures'

type ParkedTerminalCaptureArgs = {
  worktreeId: string
  tabIds: readonly string[]
  repos: readonly RepoConnection[]
  /** Ordinary parks keep the bytes client-local; force-parks share them. See ShutdownBufferCaptureOptions. */
  localOnly: boolean
}

/** Serialize a parked worktree's panes before the park unmounts them.
 *  Why every park and not only force-park: a remote-runtime pane's bytes never transit main, so its
 *  xterm buffer is the only client-side copy, and the paired-parking capability that licenses the
 *  unmount is a static build string — never evidence the host retained this pty's buffer. A host
 *  that answers `no-serializable-buffer` (or stays silent) is unverifiable, not empty, so the park
 *  must leave a copy behind. See docs/reference/ssh-execution-boundary.md.
 *  Returns whether the episode covered every tab; false leaves it unmarked so a later episode retries. */
export function captureParkedTerminalBuffers({
  worktreeId,
  tabIds,
  repos,
  localOnly
}: ParkedTerminalCaptureArgs): boolean {
  // Why skip local worktrees: includeLocalBuffers:false serializes nothing for them, so the only
  // effect left is setTabLayout replacing away a stored buffer (e.g. an exited setup pane's output).
  if (!shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)) {
    return true
  }
  const { requested, captured } = captureTerminalShutdownBuffersBestEffort(tabIds, {
    includeLocalBuffers: false,
    localOnly
  })
  return captured === requested
}
