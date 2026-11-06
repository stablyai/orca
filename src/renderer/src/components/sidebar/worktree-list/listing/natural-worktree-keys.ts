import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { isCollectionSectionKey } from '../../worktree-list-collections'

type NaturalWorktreeKeyRow = { type: string } & Partial<{
  sectionKey: string
  worktree: { id: string; hostId?: ExecutionHostId }
}>

/** Pinned duplicates have no separate natural drag slot, and a collection row is the same kind of
 * duplicate; avoid allocating arrays per row during rebuilds.
 * Keyed by host identity so a pinned card is not mistaken for its natural twin on another host. */
export function getNaturalWorktreeKeys(rows: readonly NaturalWorktreeKeyRow[]): Set<string> {
  const keys = new Set<string>()
  for (const row of rows) {
    if (
      row.type === 'item' &&
      row.sectionKey !== PINNED_GROUP_KEY &&
      !isCollectionSectionKey(row.sectionKey) &&
      row.worktree
    ) {
      keys.add(composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id))
    }
  }
  return keys
}
