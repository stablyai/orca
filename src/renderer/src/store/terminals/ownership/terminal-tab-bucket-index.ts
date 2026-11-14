import { isIndexKey } from '@/store/keyed-record-index-keys'

export type TerminalTabOwnerBuckets<T extends { id: string } = { id: string }> = Readonly<
  Record<string, readonly T[]>
>

export type IndexedTerminalTabBucket = {
  source: readonly { id: string }[]
  tabIds: ReadonlySet<string>
  firstPositions?: ReadonlyMap<string, number>
}

export function indexTerminalTabBucket(tabs: readonly { id: string }[]): IndexedTerminalTabBucket {
  const tabIds = new Set<string>()
  for (const tab of tabs) {
    tabIds.add(tab.id)
  }
  return { source: tabs, tabIds }
}

export function firstTerminalTabInBucket<T extends { id: string }>(
  bucket: IndexedTerminalTabBucket | undefined,
  tabs: readonly T[] | undefined,
  tabId: string
): T | undefined {
  if (!bucket || !tabs) {
    return undefined
  }
  if (!bucket.firstPositions) {
    const firstPositions = new Map<string, number>()
    tabs.forEach((tab, position) => {
      if (!firstPositions.has(tab.id)) {
        firstPositions.set(tab.id, position)
      }
    })
    bucket.firstPositions = firstPositions
  }
  const position = bucket.firstPositions.get(tabId)
  return position === undefined ? undefined : tabs[position]
}

export function compareTerminalTabBucketOrder(
  bucketOrder: ReadonlyMap<string, number>,
  a: string,
  b: string
): number {
  const numericA = isIndexKey(a)
  const numericB = isIndexKey(b)
  if (numericA || numericB) {
    return numericA && numericB ? Number(a) - Number(b) : numericA ? -1 : 1
  }
  return bucketOrder.get(a)! - bucketOrder.get(b)!
}
