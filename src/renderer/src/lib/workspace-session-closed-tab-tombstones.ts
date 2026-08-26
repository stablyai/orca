import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { pruneClosedTerminalTabTombstones } from '../../../shared/closed-terminal-tab-tombstones'

// Why: omit an empty map, matching the defaultTerminalTabsAppliedByWorktreeId pattern.
export function buildPersistedClosedTabTombstones(
  map: WorkspaceSessionState['closedTerminalTabTombstonesByTabId']
): WorkspaceSessionState['closedTerminalTabTombstonesByTabId'] {
  const pruned = pruneClosedTerminalTabTombstones(map, Date.now())
  return Object.keys(pruned).length > 0 ? pruned : undefined
}
