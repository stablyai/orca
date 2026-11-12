import { describe, expect, it } from 'vitest'
import { createTerminalTabOwnerIndex } from './terminal-tab-owner-index'
import { replaceTabBuckets } from '@/store/keyed-record-transitions'

describe('terminal tab owner index', () => {
  it('keeps first and last ownership in object order after integer workspace additions', () => {
    const duplicate = [{ id: 'duplicate-tab' }]
    const initial = { '2': duplicate, workspace: duplicate }
    const index = createTerminalTabOwnerIndex()
    index.getOwners(initial)

    const next = replaceTabBuckets(initial, [
      ['3', duplicate],
      ['1', duplicate]
    ])

    expect(index.getFirstOwner(next, 'duplicate-tab')).toBe('1')
    expect(index.getOwner(next, 'duplicate-tab')).toBe('workspace')
  })

  it('uses final addition order after a newly added workspace is removed and added again', () => {
    const duplicate = [{ id: 'duplicate-tab' }]
    const initial = { existing: [{ id: 'unrelated-tab' }] }
    const index = createTerminalTabOwnerIndex()
    index.getOwners(initial)
    const first = replaceTabBuckets(initial, [['temporary', duplicate]])
    const second = replaceTabBuckets(first, [['later', duplicate]])
    const removed = replaceTabBuckets(second, [['temporary', null]])
    const next = replaceTabBuckets(removed, [['temporary', duplicate]])

    expect(index.getFirstOwner(next, 'duplicate-tab')).toBe('later')
    expect(index.getOwner(next, 'duplicate-tab')).toBe('temporary')
  })

  it('reads the first current duplicate after positions shift and metadata is adopted', () => {
    const initial = {
      A: [
        { id: 'a', title: 'First' },
        { id: 'x', title: 'Middle' },
        { id: 'a', title: 'Second' }
      ],
      B: [{ id: 'a', title: 'Outside' }]
    }
    const index = createTerminalTabOwnerIndex()
    expect(index.getFirstTab(initial, 'a')?.title).toBe('First')
    expect(index.getTab(initial, 'a')?.title).toBe('Outside')
    expect(index.getOwner(initial, 'a')).toBe('B')
    expect(index.hasOwnerOutside(initial, 'a', 'A')).toBe(true)
    expect(index.hasOwnerOutside(initial, 'a', 'B')).toBe(true)
    expect(index.hasOwnerOutside(initial, 'missing', 'A')).toBe(false)
    expect(index.hasOwnerOutside(initial, 'x', 'A')).toBe(false)

    const next = replaceTabBuckets(initial, [
      ['A', [initial.A[1], initial.A[2]]],
      ['B', null]
    ])
    expect(index.getFirstTab(next, 'a')?.title).toBe('Second')
    expect(index.getTab(next, 'a')?.title).toBe('Second')
    expect(index.getFirstTab(next, 'x')?.title).toBe('Middle')
    expect(index.hasOwnerOutside(next, 'a', 'A')).toBe(false)

    const renamed = { ...next, A: next.A.map((tab) => ({ ...tab, title: `Updated ${tab.id}` })) }
    index.adoptMetadataOnlyBucketReplacements(next, renamed, ['A'])
    expect(index.getFirstTab(renamed, 'a')?.title).toBe('Updated a')
    expect(index.getTab(renamed, 'a')?.title).toBe('Updated a')
  })
})
