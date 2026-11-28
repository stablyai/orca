import { deletePaneScopedCacheEntry, movePaneScopedMapEntries } from '../pane-scoped-cache-entries'

type PaneStateSlot = {
  clearPane(paneKey: string): void
  movePane(from: string, to: string): void
  clearAll(): void
  hasClaim(paneKey: string): boolean
}

/** Providers register their maps once so pane teardown and moves cannot leave claims behind. */
export class ProviderHookStateSlots {
  private readonly slots = new Set<PaneStateSlot>()

  createMap<Value>(claims: boolean): Map<string, Value> {
    const map = new Map<string, Value>()
    this.slots.add({
      clearPane: (paneKey) => deletePaneScopedCacheEntry(map, paneKey),
      movePane: (from, to) => movePaneScopedMapEntries(map, from, to),
      clearAll: () => map.clear(),
      hasClaim: (paneKey) => claims && map.has(paneKey)
    })
    return map
  }

  clearPane(paneKey: string): void {
    this.slots.forEach((slot) => slot.clearPane(paneKey))
  }

  movePane(from: string, to: string): void {
    this.slots.forEach((slot) => slot.movePane(from, to))
  }

  clearAll(): void {
    this.slots.forEach((slot) => slot.clearAll())
  }

  hasClaims(paneKey: string): boolean {
    return [...this.slots].some((slot) => slot.hasClaim(paneKey))
  }
}

/** A provider-owned pane map, registered with each listener's slots on first use. */
export function providerPaneStateSlot<Value>(
  claims: boolean
): (slots: ProviderHookStateSlots) => Map<string, Value> {
  const maps = new WeakMap<ProviderHookStateSlots, Map<string, Value>>()
  return (slots) => {
    let map = maps.get(slots)
    if (!map) {
      map = slots.createMap<Value>(claims)
      maps.set(slots, map)
    }
    return map
  }
}
