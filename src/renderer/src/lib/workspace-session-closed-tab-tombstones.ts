import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { pruneClosedTerminalTabTombstones } from '../../../shared/closed-terminal-tab-tombstones'

/** Applies the TTL/cap bound on the way to disk, and omits an empty map like its siblings. */
export function buildPersistedClosedTerminalTabTombstones(
  map: WorkspaceSessionState['closedTerminalTabTombstonesByTabId']
): WorkspaceSessionState['closedTerminalTabTombstonesByTabId'] {
  const pruned = pruneClosedTerminalTabTombstones(map, Date.now())
  return Object.keys(pruned).length > 0 ? pruned : undefined
}
