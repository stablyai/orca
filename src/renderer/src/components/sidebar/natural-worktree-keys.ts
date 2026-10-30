import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type NaturalWorktreeKeyRow = { type: string } & Partial<{
  sectionKey: string
  worktree: { id: string; hostId?: ExecutionHostId }
}>

/** Pinned duplicates have no separate natural drag slot; avoid allocating arrays per row during rebuilds.
 * Keyed by host identity so a pinned card is not mistaken for its natural twin on another host. */
export function getNaturalWorktreeKeys(rows: readonly NaturalWorktreeKeyRow[]): Set<string> {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY && row.worktree) {
      keys.add(composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id))
    }
  }
  return keys
}
