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
})
