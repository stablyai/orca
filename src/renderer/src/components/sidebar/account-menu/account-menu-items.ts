import { useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'

export type AccountMenuItem = {
  /** Stable id; registering the same id again replaces the earlier entry. */
  id: string
  /** Called at render time so registered labels follow the active locale. */
  label: () => string
  icon?: ComponentType<{ className?: string }>
  /** Lower sorts first; ties keep registration order. */
  order?: number
  /** Hide the item unless the signed-in account reports this capability flag as true. */
  requiredCapability?: string
  onSelect: () => void
}

let items: readonly AccountMenuItem[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Adds an entry to the sidebar account menu; returns a disposer that removes exactly this entry. */
export function registerAccountMenuItem(item: AccountMenuItem): () => void {
  items = [...items.filter((existing) => existing.id !== item.id), item]
  emit()
  return () => {
    if (!items.includes(item)) {
      return
    }
    items = items.filter((existing) => existing !== item)
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRegisteredAccountMenuItems(): readonly AccountMenuItem[] {
  return items
}

export function selectVisibleAccountMenuItems(
  registered: readonly AccountMenuItem[],
  authStatus: OrcaProfileAuthStatus | null
): AccountMenuItem[] {
  const flags = authStatus?.state === 'connected' ? authStatus.capabilities?.flags : undefined
  return registered
    .filter((item) => !item.requiredCapability || flags?.[item.requiredCapability] === true)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index)
    .map(({ item }) => item)
}

export function useRegisteredAccountMenuItems(): readonly AccountMenuItem[] {
  return useSyncExternalStore(subscribe, getRegisteredAccountMenuItems)
}
