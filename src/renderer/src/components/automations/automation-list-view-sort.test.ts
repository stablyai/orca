import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAutomationListViewItems,
  sortAutomationListViewItems,
  type AutomationListSort,
  type AutomationListViewItem
} from './automation-list-view'
import { makeAutomation } from './automations-page-fixtures'

const locale = vi.hoisted(() => ({ value: 'en' }))
vi.mock('@/i18n/i18n', () => ({ getIntlLocale: () => locale.value }))

afterEach(() => {
  vi.restoreAllMocks()
  locale.value = 'en'
})

function rows(count = 512): AutomationListViewItem[] {
  const names = ['Alpha', 'álpha', 'Ångström', 'Zebra', 'Örebro', 'I', 'ı', 'İ', 'job 10', 'job 2']
  return buildAutomationListViewItems({
    automations: Array.from({ length: count }, (_, index) =>
      makeAutomation({ id: `job-${index}`, name: names[(index * 7) % names.length] })
    ),
    externalEntries: [],
    runs: []
  })
}

function previousOrder(items: AutomationListViewItem[], sort: AutomationListSort) {
  function compare(left: AutomationListViewItem, right: AutomationListViewItem) {
    const value =
      sort.field === 'name'
        ? left.name.localeCompare(right.name, locale.value, { sensitivity: 'base' })
        : (left.lastRunAt ?? 0) - (right.lastRunAt ?? 0)
    return value !== 0
      ? sort.direction === 'asc'
        ? value
        : -value
      : left.id.localeCompare(right.id)
  }
  return [...items].sort(compare)
}

describe('automation list collation', () => {
  it.each(['en', 'sv', 'tr', 'ja'])(
    'preserves %s ordering, tie-breaks and input identity',
    (language) => {
      locale.value = language
      const items = rows()
      const original = [...items]
      for (const direction of ['asc', 'desc'] as const) {
        const sort = { field: 'name', direction } as const
        const expected = previousOrder(items, sort)
        const result = sortAutomationListViewItems(items, sort)
        expect(result).toEqual(expected)
        expect(result.every((row, index) => row === expected[index])).toBe(true)
      }
      expect(items).toEqual(original)
    }
  )

  it('resolves collation once per name sort and responds to locale changes', () => {
    const items = rows()
    const OriginalCollator = Intl.Collator
    const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new OriginalCollator(locales, options)
    })
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    sortAutomationListViewItems(items, { field: 'name', direction: 'asc' })
    locale.value = 'sv'
    sortAutomationListViewItems(items, { field: 'name', direction: 'desc' })
    expect(construct.mock.calls).toEqual([
      ['en', { sensitivity: 'base' }],
      ['sv', { sensitivity: 'base' }]
    ])
    expect(compare.mock.calls.filter((args) => args.length >= 3)).toHaveLength(0)
  })

  it('does not construct collation for unsorted, time-sorted or trivial lists', () => {
    const items = rows()
    const construct = vi.spyOn(Intl, 'Collator')
    expect(sortAutomationListViewItems(items, null)).toEqual(items)
    const sort = { field: 'lastRun', direction: 'desc' } as const
    expect(sortAutomationListViewItems(items, sort)).toEqual(previousOrder(items, sort))
    expect(sortAutomationListViewItems([], { field: 'name', direction: 'asc' })).toEqual([])
    expect(
      sortAutomationListViewItems(items.slice(0, 1), { field: 'name', direction: 'asc' })
    ).toEqual(items.slice(0, 1))
    expect(construct).not.toHaveBeenCalled()
  })
})
