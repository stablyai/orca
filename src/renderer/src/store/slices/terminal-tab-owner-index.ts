type TerminalTabOwnerBuckets = Readonly<Record<string, readonly { id: string }[]>>

type IndexedBucket = {
  source: readonly { id: string }[]
  tabIds: ReadonlySet<string>
}

export type TerminalTabOwnerIndex = {
  getOwners(tabsByWorktree: TerminalTabOwnerBuckets): ReadonlyMap<string, string>
  getOwner(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): string | null
  adoptMetadataOnlyBucketReplacements(
    previousTabsByWorktree: TerminalTabOwnerBuckets,
    nextTabsByWorktree: TerminalTabOwnerBuckets,
    replacedWorktreeIds: Iterable<string>
  ): void
}

export function createTerminalTabOwnerIndex(): TerminalTabOwnerIndex {
  let source: TerminalTabOwnerBuckets | null = null
  let orderedKeys: string[] = []
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

      // Why: tab arrays are the immutable topology buckets. Reading ids only for a
      // replaced bucket keeps a one-worktree title update independent of fleet size.
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
        // Why: this fast path is valid only for title-only bucket replacements.
        // Falling back to the normal diff keeps an unexpected caller mismatch correct.
        source = null
        return
      }
      indexed.source = nextTabs
    }
    // Why: title writes preserve ids and outer key order, so ownership is unchanged.
    // Adopting the exact produced map keeps the next hot lookup O(1).
    source = nextTabsByWorktree
  }

  return {
    getOwners: update,
    getOwner: (tabsByWorktree, tabId) => update(tabsByWorktree).get(tabId) ?? null,
    adoptMetadataOnlyBucketReplacements
  }
}

const sharedTerminalTabOwnerIndex = createTerminalTabOwnerIndex()

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
  sharedTerminalTabOwnerIndex.adoptMetadataOnlyBucketReplacements(
    previousTabsByWorktree,
    nextTabsByWorktree,
    replacedWorktreeIds
  )
}
