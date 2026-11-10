import { readRecordChanges } from '../keyed-record-change-reads'

export type Reverse = Map<string, Set<string>>
export function changedKeys(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>
): { keys: Iterable<string>; reordered: boolean } {
  const changes = readRecordChanges(after, before)
  if (changes === null) {
    return { keys: [], reordered: false }
  }
  if (changes.kind === 'addressed') {
    return { keys: changes.keys, reordered: false }
  }
  const oldKeys = Object.keys(before),
    nextKeys = Object.keys(after)
  const keys = [...new Set([...oldKeys, ...nextKeys])]
  const reordered =
    oldKeys.length !== nextKeys.length || oldKeys.some((key, at) => key !== nextKeys[at])
  return {
    reordered,
    keys: reordered
      ? keys
      : keys.filter(
          (key) =>
            before[key] !== after[key] || Object.hasOwn(before, key) !== Object.hasOwn(after, key)
        )
  }
}

export function replaceMembership(
  index: Reverse,
  tabId: string,
  before: ReadonlySet<string> | ReadonlyMap<string, number>,
  after: ReadonlySet<string> | ReadonlyMap<string, number>
): void {
  for (const key of before.keys()) {
    if (after.has(key)) {
      continue
    }
    const tabs = index.get(key)
    tabs?.delete(tabId)
    if (!tabs?.size) {
      index.delete(key)
    }
  }
  for (const key of after.keys()) {
    if (before.has(key)) {
      continue
    }
    const tabs = index.get(key) ?? new Set<string>()
    tabs.add(tabId)
    index.set(key, tabs)
  }
}

export function outside(index: Reverse, key: string, tabId: string): boolean {
  const tabs = index.get(key)
  return tabs !== undefined && (tabs.size > 1 || !tabs.has(tabId))
}

export function resyncTerminalMembershipWorkspaceIds(
  source: Readonly<Record<string, unknown>>
): string[] {
  return Object.keys(source)
}
