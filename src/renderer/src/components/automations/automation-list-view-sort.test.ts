import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAutomationListViewItems,
  sortAutomationListViewItems,
  type AutomationListSort,
  type AutomationListViewItem
} from './automation-list-view'
import { unscopedAutomationListRows } from './automation-list-row-identity'
import { makeAutomation } from './automations-page-fixtures'

afterEach(() => {
  vi.restoreAllMocks()
})

function items(count = 512): AutomationListViewItem[] {
  const names = ['Alpha', 'álpha', 'Ångström', 'Zebra', 'Örebro', 'I', 'ı', 'İ', 'job 10', 'job 2']
  return buildAutomationListViewItems({
    rows: unscopedAutomationListRows(
      Array.from({ length: count }, (_, index) =>
        makeAutomation({
          id: `job-${index}`,
          name: names[(index * 7) % names.length]
        })
      )
    ),
    externalEntries: []
  })
}

/** The pre-collator comparator, resolving options on every comparison. */
function previousOrder(list: AutomationListViewItem[], sort: AutomationListSort, locale: string) {
  function compare(left: AutomationListViewItem, right: AutomationListViewItem) {
    const value =
      sort.field === 'name'
        ? left.name.localeCompare(right.name, locale, { sensitivity: 'base' })
        : (left.lastRunAt ?? 0) - (right.lastRunAt ?? 0)
    return value !== 0
      ? sort.direction === 'asc'
        ? value
        : -value
      : left.id.localeCompare(right.id)
  }
  return [...list].sort(compare)
}

describe('automation list collation', () => {
  it.each(['en', 'sv', 'tr', 'ja'])(
    'preserves %s ordering, tie-breaks and input identity',
    (locale) => {
      const list = items()
      const original = [...list]
      for (const direction of ['asc', 'desc'] as const) {
        const sort = { field: 'name', direction } as const
        const expected = previousOrder(list, sort, locale)
        const result = sortAutomationListViewItems(list, sort, locale)
        expect(result).toEqual(expected)
        expect(result.every((row, index) => row === expected[index])).toBe(true)
      }
      expect(list).toEqual(original)
    }
  )

  it('resolves collation once per name sort and follows the locale it is given', () => {
    const list = items()
    const OriginalCollator = Intl.Collator
    const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new OriginalCollator(locales, options)
    })
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    sortAutomationListViewItems(list, { field: 'name', direction: 'asc' }, 'en')
    sortAutomationListViewItems(list, { field: 'name', direction: 'desc' }, 'sv')
    expect(construct.mock.calls).toEqual([
      ['en', { sensitivity: 'base' }],
      ['sv', { sensitivity: 'base' }]
    ])
    expect(compare.mock.calls.filter((args) => args.length >= 3)).toHaveLength(0)
  })

  it('orders by row key, not the bare automation ID, so hosts cannot collapse', () => {
    const duplicate = makeAutomation({ id: 'shared', name: 'Same' })
    const list = buildAutomationListViewItems({
      rows: [
        {
          key: 'row|host-b|shared',
          automation: duplicate,
          hostLabel: 'b',
          usageSummary: null
        },
        {
          key: 'row|host-a|shared',
          automation: duplicate,
          hostLabel: 'a',
          usageSummary: null
        }
      ],
      externalEntries: []
    })
    const sorted = sortAutomationListViewItems(list, { field: 'name', direction: 'asc' }, 'en')
    expect(sorted.map((item) => item.id)).toEqual(['row|host-a|shared', 'row|host-b|shared'])
  })

  it('does not construct collation for unsorted, time-sorted or trivial lists', () => {
    const list = items()
    const construct = vi.spyOn(Intl, 'Collator')
    expect(sortAutomationListViewItems(list, null, 'en')).toEqual(list)
    const sort = { field: 'lastRun', direction: 'desc' } as const
    expect(sortAutomationListViewItems(list, sort, 'en')).toEqual(previousOrder(list, sort, 'en'))
    expect(sortAutomationListViewItems([], { field: 'name', direction: 'asc' }, 'en')).toEqual([])
    expect(
      sortAutomationListViewItems(list.slice(0, 1), { field: 'name', direction: 'asc' }, 'en')
    ).toEqual(list.slice(0, 1))
    expect(construct).not.toHaveBeenCalled()
  })
})
