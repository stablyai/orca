import { useMemo, useSyncExternalStore } from 'react'
import type { ResourcePtyGroup } from './resource-pty-view-model'
import { canEndResourcePty, type ResourcePtyEndingSource } from './use-resource-pty-actions'

export function useResourcePtyEndableGroups(
  groups: readonly ResourcePtyGroup[],
  ending: ResourcePtyEndingSource
): ReadonlySet<string> {
  const index = useMemo(() => {
    const groupByIdentity = new Map<string, string>()
    const totals = new Map<string, number>()
    for (const group of groups) {
      let count = 0
      for (const row of group.rows) {
        if (canEndResourcePty(row)) {
          groupByIdentity.set(row.identity, group.key)
          count += 1
        }
      }
      if (count > 0) {
        totals.set(group.key, count)
      }
    }
    const remaining = new Map(totals)
    let available = new Set(totals.keys())
    const update = (identities: Iterable<string>, started: boolean): boolean => {
      let next: Set<string> | undefined
      for (const identity of identities) {
        const group = groupByIdentity.get(identity)
        if (group === undefined) {
          continue
        }
        const before = remaining.get(group)!
        const after = before + (started ? -1 : 1)
        remaining.set(group, after)
        if (after === 0 || before === 0) {
          next ??= new Set(available)
          if (after === 0) {
            next.delete(group)
          } else {
            next.add(group)
          }
        }
      }
      if (!next) {
        return false
      }
      available = next
      return true
    }
    return {
      getSnapshot: () => available,
      subscribe: (onChange: () => void) => {
        // Rebase on subscription so commits cannot miss an enqueue or completion during render.
        const previous = available
        remaining.clear()
        for (const [group, count] of totals) {
          remaining.set(group, count)
        }
        available = new Set(totals.keys())
        update(ending.getKeys(), true)
        if (available.size === previous.size && [...available].every((key) => previous.has(key))) {
          available = previous
        }
        return ending.subscribe((keys, started) => {
          if (update(keys, started)) {
            onChange()
          }
        })
      }
    }
  }, [groups, ending])
  return useSyncExternalStore(index.subscribe, index.getSnapshot)
}
