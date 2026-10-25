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

/** Capture every remote park: build capability does not prove retained host bytes, and unavailable snapshots are unverifiable, not empty. False coverage leaves the episode unmarked for retry (docs/reference/ssh-execution-boundary.md). */
export function captureParkedTerminalBuffers({
  worktreeId,
  tabIds,
  repos,
  localOnly
}: ParkedTerminalCaptureArgs): boolean {
  // Local capture is disabled here; replacing its layout would only erase stored buffers such as exited setup output.
  if (!shouldPreserveTerminalScrollbackBuffers(worktreeId, repos)) {
    return true
  }
  const { requested, captured } = captureTerminalShutdownBuffersBestEffort(tabIds, {
    includeLocalBuffers: false,
    localOnly
  })
  return captured === requested
}
