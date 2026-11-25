import type { AppState } from '@/store/types'
import { readTabRowChanges } from '@/store/record-transitions/keyed-tab-row-changes'
import type { WorkerTabStamp } from '../../../../shared/orchestration/workers/worker-tab-stamp'

type LegacyTabs = AppState['tabsByWorktree']
type StampedAddresses = Map<string, Map<string, WorkerTabStamp | null>>
type LegacyAddressIndex = {
  source: WeakRef<LegacyTabs>
  addresses: StampedAddresses
  duplicateWorktrees: Set<string>
}

let index: LegacyAddressIndex | undefined

function putStamp(
  addresses: StampedAddresses,
  id: string,
  worktreeId: string,
  stamp: WorkerTabStamp | null,
  duplicate = false
): void {
  let owners = addresses.get(id)
  if (!owners) {
    owners = new Map()
    addresses.set(id, owners)
  }
  owners.set(worktreeId, duplicate && owners.has(worktreeId) ? null : stamp)
}

function buildIndex(tabs: LegacyTabs): LegacyAddressIndex {
  const addresses: StampedAddresses = new Map()
  const duplicateWorktrees = new Set<string>()
  for (const [worktreeId, rows] of Object.entries(tabs)) {
    const seen = new Set<string>()
    for (const row of rows) {
      const id = row.id
      const duplicate = seen.has(id)
      if (duplicate) {
        duplicateWorktrees.add(worktreeId)
      }
      seen.add(id)
      const stamp = row.workerTab
      if (stamp) {
        putStamp(addresses, id, worktreeId, row.worktreeId === worktreeId ? stamp : null, duplicate)
      }
    }
  }
  return { source: new WeakRef(tabs), addresses, duplicateWorktrees }
}

function applyChanges(index: LegacyAddressIndex, next: LegacyTabs, previous: LegacyTabs): boolean {
  const changes = readTabRowChanges(next, previous)
  if (!changes || changes === 'unknown') {
    return false
  }
  const { addresses, duplicateWorktrees } = index
  for (const [worktreeId, rows] of changes) {
    if (duplicateWorktrees.has(worktreeId)) {
      return false
    }
    for (const [id, { before, after }] of rows) {
      // An apparent insertion can also be a duplicate in the bucket's ID-based journal.
      if (!before) {
        return false
      }
      if (after?.workerTab) {
        putStamp(
          addresses,
          id,
          worktreeId,
          after.worktreeId === worktreeId ? after.workerTab : null
        )
        continue
      }
      const owners = addresses.get(id)
      if (owners?.delete(worktreeId) && owners.size === 0) {
        addresses.delete(id)
      }
    }
  }
  index.source = new WeakRef(next)
  return true
}

/** Ordinary closes publish row removals, so each subsequent guard reuses unchanged addresses. */
export function stampedLegacyCloseAddresses(
  tabs: LegacyTabs
): ReadonlyMap<string, ReadonlyMap<string, WorkerTabStamp | null>> {
  const previous = index?.source.deref()
  if (!index || (previous !== tabs && (!previous || !applyChanges(index, tabs, previous)))) {
    index = buildIndex(tabs)
  }
  return index.addresses
}
