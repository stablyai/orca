import { expect, it } from 'vitest'
import { orderByTabRecency, type TabRecency } from './tab-search-results'

it('lists the most recently focused tab first and the tab on screen last, like Chrome', () => {
  const tabs: (TabRecency & { id: string })[] = [
    { id: 'current', isCurrent: true, lastFocusedAt: 500 },
    { id: 'never-a', isCurrent: false, lastFocusedAt: null },
    { id: 'older', isCurrent: false, lastFocusedAt: 100 },
    { id: 'never-b', isCurrent: false, lastFocusedAt: null },
    { id: 'newest', isCurrent: false, lastFocusedAt: 300 }
  ]
  expect(orderByTabRecency(tabs, (tab) => tab).map((tab) => tab.id)).toEqual([
    'newest',
    'older',
    'never-a',
    'never-b',
    'current'
  ])
})
