import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { ResourcePtyGroup } from './resource-pty-view-model'
import { canEndResourcePty } from './use-resource-pty-actions'
import type { ResourcePtyEndingSource } from './resource-pty-action-status'

type Endability = { total: number; remaining: number; onChange?: () => void }

function indexGroupEndability(groups: readonly ResourcePtyGroup[]) {
  const byKey = new Map<string, Endability>()
  const byRow = new Map<string, Endability>()
  for (const group of groups) {
    const counts = { total: 0, remaining: 0 }
    for (const row of group.rows) {
      if (canEndResourcePty(row)) {
        byRow.set(row.identity, counts)
        counts.total += 1
      }
    }
    counts.remaining = counts.total
    byKey.set(group.key, counts)
  }
  return { byKey, byRow }
}

export function useResourcePtyEndableGroups(
  groups: readonly ResourcePtyGroup[],
  ending: ResourcePtyEndingSource
) {
  const index = useMemo(() => indexGroupEndability(groups), [groups])
  useLayoutEffect(() => {
    if (groups.length === 0) {
      return
    }
    // Rebase the index on the queue before paint, including terminations started while it was hidden.
    for (const counts of index.byKey.values()) {
      counts.remaining = counts.total
    }
    for (const identity of ending.getKeys()) {
      const counts = index.byRow.get(identity)
      if (counts) {
        counts.remaining -= 1
      }
    }
    for (const counts of index.byKey.values()) {
      counts.onChange?.()
    }
    return ending.subscribe((identities, started) => {
      for (const identity of identities) {
        const counts = index.byRow.get(identity)
        if (counts) {
          const wasAvailable = counts.remaining > 0
          counts.remaining += started ? -1 : 1
          if (wasAvailable !== counts.remaining > 0) {
            counts.onChange?.()
          }
        }
      }
    })
  }, [ending, groups.length, index])
  return index.byKey
}

export function useResourcePtyGroupCanEnd(
  endableGroups: ReadonlyMap<string, Endability>,
  key: string
): boolean {
  const counts = endableGroups.get(key)
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (counts) {
        counts.onChange = onChange
      }
      return () => {
        if (counts?.onChange === onChange) {
          delete counts.onChange
        }
      }
    },
    [counts]
  )
  const getSnapshot = useCallback(() => !!counts && counts.remaining > 0, [counts])
  return useSyncExternalStore(subscribe, getSnapshot)
}
