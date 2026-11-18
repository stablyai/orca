import { expect, it } from 'vitest'
import { getTopActivityBarLayout } from './activity-bar-overflow'

it('holds room for a More button that carries a hidden active tab', () => {
  const items = [
    { id: 'explorer' as const, title: 'Explorer' },
    { id: 'checks' as const, title: 'Checks' },
    { id: 'vault' as const, title: 'Agents' }
  ]
  const fits = getTopActivityBarLayout(items, 110, 'plugin:test/panel', 0)
  expect(fits.overflowItems).toEqual([])
  const reserved = getTopActivityBarLayout(items, 110, 'plugin:test/panel', 0, undefined, true)
  expect(reserved.visibleItems.map((item) => item.id)).toEqual(['explorer', 'checks'])
  expect(reserved.overflowItems.map((item) => item.id)).toEqual(['vault'])
})

it('keeps the More slot for a hidden active tab in a six-icon 228px strip', () => {
  const items = [
    { id: 'explorer' as const, title: 'Explorer' },
    { id: 'vault' as const, title: 'Agents' },
    { id: 'workspaces' as const, title: 'Worktrees' },
    { id: 'pr-checks' as const, title: 'PR Checks' },
    { id: 'source-control' as const, title: 'Source Control' },
    { id: 'checks' as const, title: 'Checks' }
  ]
  const allFit = getTopActivityBarLayout(items, 228, 'plugin:test/panel', 8)
  expect(allFit.visibleItems.map((item) => item.id)).toHaveLength(6)
  const withMore = getTopActivityBarLayout(items, 228, 'plugin:test/panel', 8, undefined, true)
  expect(withMore.visibleItems.map((item) => item.id)).toEqual([
    'explorer',
    'vault',
    'workspaces',
    'pr-checks',
    'source-control'
  ])
  expect(withMore.overflowItems.map((item) => item.id)).toEqual(['checks'])
})
