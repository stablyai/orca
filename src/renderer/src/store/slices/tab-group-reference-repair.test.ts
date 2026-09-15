import { describe, expect, it } from 'vitest'
import type { TabGroup } from '../../../../shared/tab-types'
import { appendOwnedTabIdsToGroups } from './tab-group-reference-repair'

function group(id: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId: 'workspace', activeTabId: null, tabOrder, recentTabIds: [] }
}

describe('appendOwnedTabIdsToGroups', () => {
  it('preserves existing order, duplicates, and untouched group identities', () => {
    const complete = group('complete', ['b', 'a', 'a'])
    const missing = group('missing', ['stale', 'c'])
    const unowned = group('unowned', ['external'])
    const owners = new Map([
      ['a', 'complete'],
      ['b', 'complete'],
      ['d', 'missing'],
      ['c', 'missing'],
      ['e', 'missing'],
      ['elsewhere', 'absent']
    ])
    const result = appendOwnedTabIdsToGroups([complete, missing, unowned], owners)
    expect(result).toEqual([complete, { ...missing, tabOrder: ['stale', 'c', 'd', 'e'] }, unowned])
    expect(result[0]).toBe(complete)
    expect(result[2]).toBe(unowned)
    expect(missing.tabOrder).toEqual(['stale', 'c'])
  })

  it.each([false, true])('bounds saved-order reads with missing tabs: %s', (missing) => {
    const count = 1_000
    const ids = Array.from({ length: count }, (_, i) => `tab-${i}`)
    let reads = 0
    const order = new Proxy(ids, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          reads++
        }
        return Reflect.get(target, property, receiver)
      }
    })
    const original = group('group', order)
    const ownedIds = missing ? ids.map((id) => `missing-${id}`) : ids
    const result = appendOwnedTabIdsToGroups(
      [original],
      new Map(ownedIds.map((id) => [id, original.id]))
    )
    const repairReads = reads
    expect(result[0].tabOrder).toEqual(missing ? [...ids, ...ownedIds] : ids)
    if (!missing) {
      expect(result[0]).toBe(original)
    }
    expect(repairReads).toBeLessThanOrEqual(count * 2)
  })
})
