import { readTabMapChanges } from '@/store/keyed-record-change-reads'

import {
  type TerminalTabOwnerBuckets,
  type IndexedTerminalTabBucket,
  indexTerminalTabBucket,
  firstTerminalTabInBucket,
  compareTerminalTabBucketOrder
} from './terminal-tab-bucket-index'

function diffUnknownTabOwnerKeys(tabsByWorktree: TerminalTabOwnerBuckets): string[] {
  return Object.keys(tabsByWorktree)
}

export type TerminalTabOwnerIndex = {
  getOwners(tabsByWorktree: TerminalTabOwnerBuckets): ReadonlyMap<string, string>
  getOwner(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): string | null
  getFirstOwner(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): string | null
  getFirstTab<T extends { id: string }>(
    tabsByWorktree: TerminalTabOwnerBuckets<T>,
    tabId: string
  ): T | undefined
  getTab<T extends { id: string }>(
    tabsByWorktree: TerminalTabOwnerBuckets<T>,
    tabId: string
  ): T | undefined
  hasOwnerOutside(
    tabsByWorktree: TerminalTabOwnerBuckets,
    tabId: string,
    expectedWorkspaceId: string
  ): boolean
  getOwnerIds(tabsByWorktree: TerminalTabOwnerBuckets, tabId: string): Iterable<string>
  adoptMetadataOnlyBucketReplacements(
    previousTabsByWorktree: TerminalTabOwnerBuckets,
    nextTabsByWorktree: TerminalTabOwnerBuckets,
    replacedWorktreeIds: Iterable<string>
  ): void
}

export function createTerminalTabOwnerIndex(): TerminalTabOwnerIndex {
  let source: TerminalTabOwnerBuckets | null = null
  const bucketOrder = new Map<string, number>()
  let nextBucketOrder = 0
  const bucketByWorktreeId = new Map<string, IndexedTerminalTabBucket>()
  const worktreeIdsByTabId = new Map<string, Set<string>>()
  const ownerByTabId = new Map<string, string>()
  const firstOwnerByTabId = new Map<string, string>()
  const duplicateTabIds = new Set<string>()

  const removeBucketMembership = (worktreeId: string, tabIds: ReadonlySet<string>): void => {
    for (const tabId of tabIds) {
      const worktreeIds = worktreeIdsByTabId.get(tabId)
      if (!worktreeIds) {
        continue
      }
      worktreeIds.delete(worktreeId)
      if (worktreeIds.size < 2) {
        duplicateTabIds.delete(tabId)
      }
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
        if (worktreeIds.size > 1) {
          duplicateTabIds.add(tabId)
        }
      } else {
        worktreeIdsByTabId.set(tabId, new Set([worktreeId]))
      }
    }
  }

  const resolveOwners = (tabId: string): void => {
    let owner: string | undefined
    let first: string | undefined
    for (const id of worktreeIdsByTabId.get(tabId) ?? []) {
      if (owner === undefined || compareTerminalTabBucketOrder(bucketOrder, id, owner) > 0) {
        owner = id
      }
      if (first === undefined || compareTerminalTabBucketOrder(bucketOrder, id, first) < 0) {
        first = id
      }
    }
    if (owner === undefined) {
      ownerByTabId.delete(tabId)
      firstOwnerByTabId.delete(tabId)
    } else {
      ownerByTabId.set(tabId, owner)
      firstOwnerByTabId.set(tabId, first!)
    }
  }

  const update = (tabsByWorktree: TerminalTabOwnerBuckets): ReadonlyMap<string, string> => {
    if (source === tabsByWorktree) {
      return ownerByTabId
    }

    const changes = source ? readTabMapChanges(tabsByWorktree, source) : null
    if (changes?.kind === 'addressed' && source) {
      const affectedTabIds = new Set<string>()
      for (const worktreeId of changes.addedWorkspaceIds) {
        bucketOrder.set(worktreeId, nextBucketOrder++)
      }
      for (const worktreeId of changes.workspaceIds) {
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
        const nextBucket = indexTerminalTabBucket(tabs)
        const { tabIds } = nextBucket
        bucketByWorktreeId.set(worktreeId, nextBucket)
        addBucketMembership(worktreeId, tabIds)
        for (const tabId of tabIds) {
          affectedTabIds.add(tabId)
        }
      }
      for (const tabId of affectedTabIds) {
        resolveOwners(tabId)
      }
      source = tabsByWorktree
      return ownerByTabId
    }

    // Unknown patches need a bucket identity diff; only reordered duplicate owners need revisiting.
    const nextOrderedKeys = diffUnknownTabOwnerKeys(tabsByWorktree)
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
      const nextBucket = indexTerminalTabBucket(tabs)
      const { tabIds } = nextBucket
      for (const tabId of tabIds) {
        affectedTabIds.add(tabId)
      }
      bucketByWorktreeId.set(worktreeId, nextBucket)
      addBucketMembership(worktreeId, tabIds)
    }

    const previousOrderedKeys = source ? diffUnknownTabOwnerKeys(source) : [...bucketOrder.keys()]
    const orderChanged =
      nextOrderedKeys.length !== previousOrderedKeys.length ||
      nextOrderedKeys.some((id, index) => id !== previousOrderedKeys[index])
    if (orderChanged) {
      bucketOrder.clear()
      for (const [order, id] of nextOrderedKeys.entries()) {
        bucketOrder.set(id, order)
      }
      nextBucketOrder = nextOrderedKeys.length
      const survivingKeys = previousOrderedKeys.filter((id) => nextKeySet.has(id))
      const existingKeys = nextOrderedKeys.filter((id) => source && Object.hasOwn(source, id))
      if (existingKeys.some((id, index) => id !== survivingKeys[index])) {
        for (const tabId of duplicateTabIds) {
          affectedTabIds.add(tabId)
        }
      }
    }
    for (const tabId of affectedTabIds) {
      resolveOwners(tabId)
    }

    source = tabsByWorktree
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
      return firstOwnerByTabId.get(tabId) ?? null
    },
    getFirstTab: (tabsByWorktree, tabId) => {
      update(tabsByWorktree)
      const owner = firstOwnerByTabId.get(tabId)
      return firstTerminalTabInBucket(
        owner === undefined ? undefined : bucketByWorktreeId.get(owner),
        owner === undefined ? undefined : tabsByWorktree[owner],
        tabId
      )
    },
    getTab: (tabsByWorktree, tabId) => {
      const owner = update(tabsByWorktree).get(tabId)
      return firstTerminalTabInBucket(
        owner === undefined ? undefined : bucketByWorktreeId.get(owner),
        owner === undefined ? undefined : tabsByWorktree[owner],
        tabId
      )
    },
    hasOwnerOutside: (tabsByWorktree, tabId, expectedWorkspaceId) => {
      update(tabsByWorktree)
      const owners = worktreeIdsByTabId.get(tabId)
      return owners !== undefined && (owners.size > 1 || !owners.has(expectedWorkspaceId))
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

export function getFirstTerminalTab<T extends { id: string }>(
  buckets: TerminalTabOwnerBuckets<T>,
  tabId: string
): T | undefined {
  return sharedTerminalTabOwnerIndex.getFirstTab(buckets, tabId)
}

export function terminalTabHasOwnerOutside(
  buckets: TerminalTabOwnerBuckets,
  tabId: string,
  expectedWorkspaceId: string
): boolean {
  return sharedTerminalTabOwnerIndex.hasOwnerOutside(buckets, tabId, expectedWorkspaceId)
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
  sharedTerminalTabOwnerIndex.adoptMetadataOnlyBucketReplacements(
    previousTabsByWorktree,
    nextTabsByWorktree,
    replacedWorktreeIds
  )
}

export function getTerminalTab<T extends { id: string }>(
  buckets: TerminalTabOwnerBuckets<T>,
  tabId: string
): T | undefined {
  return sharedTerminalTabOwnerIndex.getTab(buckets, tabId)
}
