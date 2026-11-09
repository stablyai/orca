// Local stand-in for the sidebar account menu's item registry, which is landing upstream at
// src/renderer/src/components/sidebar/account-menu/account-menu-items.ts with this exact shape.
// When it lands, delete this file and import registerAccountMenuItem from there instead.
import type { ComponentType } from 'react'

export type AccountMenuItem = {
  id: string
  /** Called at render so the label follows the current language. */
  label: () => string
  icon?: ComponentType<{ className?: string }>
  /** Lower sorts first. */
  order?: number
  /** Shown only when the connected account's capabilities.flags[cap] === true. */
  requiredCapability?: string
  onSelect: () => void
}

const items = new Map<string, AccountMenuItem>()

/** Same id replaces; the disposer removes exactly the entry it registered. */
export function registerAccountMenuItem(item: AccountMenuItem): () => void {
  items.set(item.id, item)
  return () => {
    if (items.get(item.id) === item) {
      items.delete(item.id)
    }
  }
}

export function registeredAccountMenuItemsForTest(): AccountMenuItem[] {
  return [...items.values()]
}
