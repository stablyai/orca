import { isIndexKey } from '@/store/keyed-record-index-keys'

export type TerminalTabOwnerBuckets<T extends { id: string } = { id: string }> = Readonly<
  Record<string, readonly T[]>
>

export type TerminalTabOwnerRow = { id: string; contentType?: string; entityId?: string }

export type IndexedTerminalTabBucket = {
  source: readonly { id: string }[]
  tabIds: ReadonlySet<string>
  positions?: ReadonlyMap<string, readonly number[]>
  tabIdOf: (row: TerminalTabOwnerRow) => string | null
}

export function indexTerminalTabBucket(
  tabs: readonly { id: string }[],
  tabIdOf: (row: TerminalTabOwnerRow) => string | null = (row) => row.id
): IndexedTerminalTabBucket {
  const tabIds = new Set<string>()
  for (const tab of tabs) {
    const id = tabIdOf(tab)
    if (id !== null) {
      tabIds.add(id)
    }
  }
  return { source: tabs, tabIds, tabIdOf }
}

export function terminalTabPositionsInBucket(
  bucket: IndexedTerminalTabBucket | undefined,
  tabs: readonly { id: string }[] | undefined,
  tabId: string
): readonly number[] {
  if (!bucket || !tabs) {
    return []
  }
  if (!bucket.positions) {
    const positions = new Map<string, number[]>()
    tabs.forEach((tab, position) => {
      const id = bucket.tabIdOf(tab)
      if (id === null) {
        return
      }
      const prior = positions.get(id) ?? []
      prior.push(position)
      positions.set(id, prior)
    })
    bucket.positions = positions
  }
  return bucket.positions.get(tabId) ?? []
}

export function firstTerminalTabInBucket<T extends { id: string }>(
  bucket: IndexedTerminalTabBucket | undefined,
  tabs: readonly T[] | undefined,
  tabId: string
): T | undefined {
  const position = terminalTabPositionsInBucket(bucket, tabs, tabId)[0]
  return position === undefined ? undefined : tabs?.[position]
}

export function lastTerminalTabInBucket<T extends { id: string }>(
  bucket: IndexedTerminalTabBucket | undefined,
  tabs: readonly T[] | undefined,
  tabId: string
): T | undefined {
  const position = terminalTabPositionsInBucket(bucket, tabs, tabId).at(-1)
  return position === undefined ? undefined : tabs?.[position]
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
