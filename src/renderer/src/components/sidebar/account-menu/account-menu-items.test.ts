import { afterEach, expect, it } from 'vitest'
import {
  getRegisteredAccountMenuItems,
  registerAccountMenuItem,
  selectVisibleAccountMenuItems,
  type AccountMenuItem
} from './account-menu-items'

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
})

function register(id: string, order?: number): () => void {
  const entry: AccountMenuItem = { id, label: () => id, order, onSelect: () => {} }
  const dispose = registerAccountMenuItem(entry)
  disposers.push(dispose)
  return dispose
}

function visibleIds(): string[] {
  return selectVisibleAccountMenuItems(getRegisteredAccountMenuItems(), null).map(
    (entry) => entry.id
  )
}

it('sorts by order, keeping registration order for ties', () => {
  register('b', 10)
  register('a', 10)
  register('c', 5)
  expect(visibleIds()).toEqual(['c', 'b', 'a'])
})

it('replaces an entry with the same id and ignores the replaced entry disposer', () => {
  const disposeOriginal = register('item', 1)
  register('other', 2)
  register('item', 3)
  disposeOriginal()
  expect(visibleIds()).toEqual(['other', 'item'])
})
