import {
  terminalInputRecordChangedKeys,
  terminalInputRecordTransition
} from './terminal-input-record-transition'

type TerminalTabOwnerBuckets = Readonly<Record<string, readonly { id: string }[]>>

type IndexedBucket = {
  source: readonly { id: string }[]
  tabIds: ReadonlySet<string>
}

export type TerminalTabOwnerIndex = {
  getOwners(tabsByWorktree: TerminalTabOwnerBuckets): ReadonlyMap<string, string>
  getOwner(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): string | null
  getFirstOwner(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): string | null
  getOwnerIds(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): Iterable<string>
  adoptMetadataOnlyBucketReplacements(
    previousTabsByWorktree: TerminalTabOwnerBuckets,
    nextTabsByWorktree: TerminalTabOwnerBuckets,
    replacedWorktreeIds: Iterable<string>
  ): void
}

export function createTerminalTabOwnerIndex(): TerminalTabOwnerIndex {
  let source: TerminalTabOwnerBuckets | null = null
  let orderedKeys: string[] = []
  const bucketOrder = new Map<string, number>()
  let nextBucketOrder = 0
  const bucketByWorktreeId = new Map<string, IndexedBucket>()
  const worktreeIdsByTabId = new Map<string, Set<string>>()
  const ownerByTabId = new Map<string, string>()

  const removeBucketMembership = (worktreeId: string, tabIds: ReadonlySet<string>): void => {
    for (const tabId of tabIds) {
      const worktreeIds = worktreeIdsByTabId.get(tabId)
      if (!worktreeIds) {
        continue
      }
      worktreeIds.delete(worktreeId)
      if (worktreeIds.size === 0) {
        worktreeIdsByTabId.delete(tabId)
      }
    }
  }

  const addBucketMembership = (worktreeId: string, tabIds: ReadonlySet<string>): void => {
    for (const tabId of tabIds) {
      const worktreeIds = worktreeIdsByTabId.get(tabId)
      if (worktreeIds) {
        worktreeIds.add(worktreeId)
      } else {
        worktreeIdsByTabId.set(tabId, new Set([worktreeId]))
      }
    }
  }

  const update = (tabsByWorktree: TerminalTabOwnerBuckets): ReadonlyMap<string, string> => {
    if (source === tabsByWorktree) {
      return ownerByTabId
    }

    const knownKeys = source ? terminalInputRecordChangedKeys(source, tabsByWorktree) : null
    if (knownKeys && source) {
      const affectedTabIds = new Set<string>()
      for (const worktreeId of knownKeys) {
        const indexed = bucketByWorktreeId.get(worktreeId)
        const tabs = tabsByWorktree[worktreeId]
        if (indexed?.source === tabs) {
          continue
        }
        if (indexed) {
          for (const tabId of indexed.tabIds) {
            affectedTabIds.add(tabId)
          }
          removeBucketMembership(worktreeId, indexed.tabIds)
        }
        if (!tabs) {
          bucketByWorktreeId.delete(worktreeId)
          bucketOrder.delete(worktreeId)
          continue
        }
        if (!indexed) {
          bucketOrder.set(worktreeId, nextBucketOrder++)
        }
        const tabIds = new Set(tabs.map((tab) => tab.id))
        bucketByWorktreeId.set(worktreeId, { source: tabs, tabIds })
        addBucketMembership(worktreeId, tabIds)
        for (const tabId of tabIds) {
          affectedTabIds.add(tabId)
        }
      }
      for (const tabId of affectedTabIds) {
        const ids = worktreeIdsByTabId.get(tabId)
        if (!ids?.size) {
          ownerByTabId.delete(tabId)
        } else if (ids.size === 1) {
          ownerByTabId.set(tabId, ids.values().next().value!)
        } else {
          let owner: string | undefined
          let rank = -1
          for (const id of ids) {
            const order = bucketOrder.get(id) ?? -1
            if (order > rank) {
              owner = id
              rank = order
            }
          }
          if (owner) {
            ownerByTabId.set(tabId, owner)
          }
        }
      }
      source = tabsByWorktree
      return ownerByTabId
    }

    // Unknown snapshots can change key order and duplicate ownership; rebuild that order once.
    const nextOrderedKeys = Object.keys(tabsByWorktree)
    const orderChanged =
      orderedKeys.length !== nextOrderedKeys.length ||
      orderedKeys.some((key, index) => key !== nextOrderedKeys[index])
    const nextKeySet = new Set(nextOrderedKeys)
    const affectedTabIds = new Set<string>()

    for (const [worktreeId, indexed] of bucketByWorktreeId) {
      if (nextKeySet.has(worktreeId)) {
        continue
      }
      for (const tabId of indexed.tabIds) {
        affectedTabIds.add(tabId)
      }
      removeBucketMembership(worktreeId, indexed.tabIds)
      bucketByWorktreeId.delete(worktreeId)
    }

    for (const worktreeId of nextOrderedKeys) {
      const tabs = tabsByWorktree[worktreeId] ?? []
      const indexed = bucketByWorktreeId.get(worktreeId)
      if (indexed?.source === tabs) {
        continue
      }

      if (indexed) {
        for (const tabId of indexed.tabIds) {
          affectedTabIds.add(tabId)
        }
        removeBucketMembership(worktreeId, indexed.tabIds)
      }

      // Immutable bucket replacement lets ownership scan only changed tab IDs, independent of fleet size.
      const tabIds = new Set(tabs.map((tab) => tab.id))
      for (const tabId of tabIds) {
        affectedTabIds.add(tabId)
      }
      bucketByWorktreeId.set(worktreeId, { source: tabs, tabIds })
      addBucketMembership(worktreeId, tabIds)
    }

    const orderByWorktreeId = new Map(
      nextOrderedKeys.map((worktreeId, index) => [worktreeId, index] as const)
    )
    const tabIdsToResolve = orderChanged ? worktreeIdsByTabId.keys() : affectedTabIds
    for (const tabId of tabIdsToResolve) {
      const worktreeIds = worktreeIdsByTabId.get(tabId)
      let owner: string | null = null
      let ownerOrder = -1
      for (const worktreeId of worktreeIds ?? []) {
        const order = orderByWorktreeId.get(worktreeId)
        if (order !== undefined && order > ownerOrder) {
          owner = worktreeId
          ownerOrder = order
        }
      }
      if (owner === null) {
        ownerByTabId.delete(tabId)
      } else {
        ownerByTabId.set(tabId, owner)
      }
    }
    for (const tabId of affectedTabIds) {
      if (!worktreeIdsByTabId.has(tabId)) {
        ownerByTabId.delete(tabId)
      }
    }

    source = tabsByWorktree
    orderedKeys = nextOrderedKeys
    bucketOrder.clear()
    for (const [id, order] of orderByWorktreeId) {
      bucketOrder.set(id, order)
    }
    nextBucketOrder = nextOrderedKeys.length
    return ownerByTabId
  }

  const adoptMetadataOnlyBucketReplacements = (
    previousTabsByWorktree: TerminalTabOwnerBuckets,
    nextTabsByWorktree: TerminalTabOwnerBuckets,
    replacedWorktreeIds: Iterable<string>
  ): void => {
    if (source !== previousTabsByWorktree) {
      return
    }
    for (const worktreeId of replacedWorktreeIds) {
      const indexed = bucketByWorktreeId.get(worktreeId)
      const previousTabs = previousTabsByWorktree[worktreeId]
      const nextTabs = nextTabsByWorktree[worktreeId]
      if (!indexed || indexed.source !== previousTabs || !nextTabs) {
        // Only title-only replacements preserve topology; unexpected callers must fall back to the normal diff.
        source = null
        return
      }
      indexed.source = nextTabs
    }
    // Titles preserve IDs/key order; adopt the produced map so the next owner lookup stays O(1).
    source = nextTabsByWorktree
  }

  return {
    getOwners: update,
    getOwner: (tabsByWorktree, tabId) => update(tabsByWorktree).get(tabId) ?? null,
    getOwnerIds: (tabsByWorktree, tabId) => {
      update(tabsByWorktree)
      return worktreeIdsByTabId.get(tabId) ?? []
    },
    getFirstOwner: (tabsByWorktree, tabId) => {
      update(tabsByWorktree)
      let owner: string | null = null
      let rank = Number.POSITIVE_INFINITY
      for (const id of worktreeIdsByTabId.get(tabId) ?? []) {
        const order = bucketOrder.get(id) ?? Number.POSITIVE_INFINITY
        if (order < rank) {
          owner = id
          rank = order
        }
      }
      return owner
    },
    adoptMetadataOnlyBucketReplacements
  }
}

const sharedTerminalTabOwnerIndex = createTerminalTabOwnerIndex()

export function getTerminalTabOwnerWorktreeIds(
  tabsByWorktree: TerminalTabOwnerBuckets,
  tabId: string
): Iterable<string> {
  return sharedTerminalTabOwnerIndex.getOwnerIds(tabsByWorktree, tabId)
}

export function getFirstTerminalTabOwnerWorktreeId(
  tabsByWorktree: TerminalTabOwnerBuckets,
  tabId: string
): string | null {
  return sharedTerminalTabOwnerIndex.getFirstOwner(tabsByWorktree, tabId)
}

export function getTerminalTabOwners(
  tabsByWorktree: TerminalTabOwnerBuckets
): ReadonlyMap<string, string> {
  return sharedTerminalTabOwnerIndex.getOwners(tabsByWorktree)
}

export function getTerminalTabOwnerWorktreeId(
  tabsByWorktree: TerminalTabOwnerBuckets,
  tabId: string
): string | null {
  return sharedTerminalTabOwnerIndex.getOwner(tabsByWorktree, tabId)
}

export function adoptTerminalTabOwnerMetadataOnlyBuckets(
  previousTabsByWorktree: TerminalTabOwnerBuckets,
  nextTabsByWorktree: TerminalTabOwnerBuckets,
  replacedWorktreeIds: Iterable<string>
): void {
  terminalInputRecordTransition(previousTabsByWorktree, nextTabsByWorktree, replacedWorktreeIds)
}
