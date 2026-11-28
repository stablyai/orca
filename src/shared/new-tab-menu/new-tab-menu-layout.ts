/** The user's arrangement of the + menu's create row. Ids absent from `order` keep their default slot. */
export type NewTabMenuLayout = {
  order: string[]
  hidden: string[]
}

/** Order and visibility of each surface's + menu create row; unset keeps the built-in arrangement. */
export type NewTabMenuSettings = {
  newTabMenuLayout?: NewTabMenuLayout
  floatingTerminalNewTabMenuLayout?: NewTabMenuLayout
}

/** Surfaces offer different items in a different default order, so each keeps its own layout. */
export type NewTabMenuSurface = 'tab-bar' | 'floating-panel'

export const NEW_TAB_MENU_LAYOUT_SETTING = {
  'tab-bar': 'newTabMenuLayout',
  'floating-panel': 'floatingTerminalNewTabMenuLayout'
} as const satisfies Record<NewTabMenuSurface, keyof NewTabMenuSettings>

const MAX_LAYOUT_IDS = 128
const MAX_LAYOUT_ID_LENGTH = 512

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const ids = new Set<string>()
  for (const id of value) {
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_LAYOUT_ID_LENGTH) {
      ids.add(id)
    }
    if (ids.size >= MAX_LAYOUT_IDS) {
      break
    }
  }
  return [...ids]
}

export function normalizeNewTabMenuLayout(value: unknown): NewTabMenuLayout | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  return {
    order: normalizeIds('order' in value ? value.order : undefined),
    hidden: normalizeIds('hidden' in value ? value.hidden : undefined)
  }
}

export type NewTabMenuArrangeable = { id: string; locked?: boolean }

/**
 * Orders the available items by the saved layout and splits off hidden ones. Items the layout has
 * never seen (a newly installed plugin file type) land right after their default predecessor.
 */
export function arrangeNewTabMenuItems<T extends NewTabMenuArrangeable>(
  items: readonly T[],
  layout: NewTabMenuLayout | undefined
): { visible: T[]; hidden: T[] } {
  const normalized = normalizeNewTabMenuLayout(layout)
  if (!normalized) {
    return { visible: [...items], hidden: [] }
  }
  const savedIndex = new Map(normalized.order.map((id, index) => [id, index]))
  const arranged = items
    .filter((item) => savedIndex.has(item.id))
    .sort((left, right) => (savedIndex.get(left.id) ?? 0) - (savedIndex.get(right.id) ?? 0))
  items.forEach((item, defaultIndex) => {
    if (savedIndex.has(item.id)) {
      return
    }
    const predecessor = items[defaultIndex - 1]
    const at = predecessor ? arranged.indexOf(predecessor) + 1 : 0
    arranged.splice(at, 0, item)
  })
  const hidden = new Set(normalized.hidden)
  return {
    visible: arranged.filter((item) => item.locked || !hidden.has(item.id)),
    hidden: arranged.filter((item) => !item.locked && hidden.has(item.id))
  }
}

/**
 * Saves a new arrangement while keeping ids that are unavailable right now (a disabled plugin,
 * the emulator on a non-Mac host), so they come back where the user left them.
 */
export function buildNewTabMenuLayout(
  visibleIds: readonly string[],
  hiddenIds: readonly string[],
  previous: NewTabMenuLayout | undefined
): NewTabMenuLayout {
  const normalizedPrevious = normalizeNewTabMenuLayout(previous)
  const arranged = new Set([...visibleIds, ...hiddenIds])
  const order = [...visibleIds, ...hiddenIds]
  const previousOrder = normalizedPrevious?.order ?? []
  previousOrder.forEach((id, index) => {
    if (arranged.has(id)) {
      return
    }
    // Keep an unavailable item right after whatever preceded it in the saved order.
    const anchor = previousOrder.slice(0, index).findLast((other) => order.includes(other))
    order.splice(anchor === undefined ? 0 : order.indexOf(anchor) + 1, 0, id)
  })
  const unavailableHidden = (normalizedPrevious?.hidden ?? []).filter((id) => !arranged.has(id))
  return {
    order: normalizeIds(order),
    hidden: normalizeIds([...hiddenIds, ...unavailableHidden])
  }
}

/** Shows or hides one item without disturbing the rest of the saved arrangement. */
export function withNewTabMenuItemHidden(
  layout: NewTabMenuLayout | undefined,
  id: string,
  hidden: boolean
): NewTabMenuLayout {
  const normalized = normalizeNewTabMenuLayout(layout)
  const others = (normalized?.hidden ?? []).filter((other) => other !== id)
  return { order: normalized?.order ?? [], hidden: hidden ? [id, ...others] : others }
}
