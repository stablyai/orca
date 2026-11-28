import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { ResourcePtyGroup } from './resource-pty-view-model'
import { canEndResourcePty } from './use-resource-pty-actions'
import type { ResourcePtyEndingSource } from './resource-pty-action-status'

type Endability = { key: string; total: number; remaining: number }

class ResourcePtyEndabilityStore {
  private readonly byKey = new Map<string, Endability>()
  private readonly byRow = new Map<string, Endability>()
  private readonly listenersByKey = new Map<string, Set<() => void>>()

  constructor(groups: readonly ResourcePtyGroup[]) {
    for (const group of groups) {
      const counts = { key: group.key, total: 0, remaining: 0 }
      for (const row of group.rows) {
        if (canEndResourcePty(row)) {
          this.byRow.set(row.identity, counts)
          counts.total += 1
        }
      }
      counts.remaining = counts.total
      this.byKey.set(group.key, counts)
    }
  }

  rebase(ending: ResourcePtyEndingSource): void {
    for (const counts of this.byKey.values()) {
      counts.remaining = counts.total
    }
    for (const identity of ending.getKeys()) {
      const counts = this.byRow.get(identity)
      if (counts) {
        counts.remaining -= 1
      }
    }
  }

  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.listenersByKey.get(key)
    if (!listeners) {
      listeners = new Set()
      this.listenersByKey.set(key, listeners)
    }
    listeners.add(listener)
    return () => listeners?.delete(listener)
  }

  canEnd(key: string): boolean {
    return (this.byKey.get(key)?.remaining ?? 0) > 0
  }

  connect(ending: ResourcePtyEndingSource): () => void {
    this.rebase(ending)
    return ending.subscribe((identities, started) => {
      const changed = new Set<string>()
      for (const identity of identities) {
        const counts = this.byRow.get(identity)
        if (!counts) {
          continue
        }
        const wasAvailable = counts.remaining > 0
        counts.remaining += started ? -1 : 1
        if (wasAvailable !== counts.remaining > 0) {
          changed.add(counts.key)
        }
      }
      for (const key of changed) {
        this.listenersByKey.get(key)?.forEach((listener) => listener())
      }
    })
  }
}

export function useResourcePtyEndableGroups(
  groups: readonly ResourcePtyGroup[],
  ending: ResourcePtyEndingSource
) {
  const store = useMemo(() => new ResourcePtyEndabilityStore(groups), [groups])
  useLayoutEffect(() => store.connect(ending), [ending, store])
  return store
}

export function useResourcePtyGroupCanEnd(
  endableGroups: ResourcePtyEndabilityStore,
  key: string
): boolean {
  const subscribe = useCallback(
    (listener: () => void) => endableGroups.subscribe(key, listener),
    [endableGroups, key]
  )
  const getSnapshot = useCallback(() => endableGroups.canEnd(key), [endableGroups, key])
  return useSyncExternalStore(subscribe, getSnapshot)
}
