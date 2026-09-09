import { describe, expect, it } from 'vitest'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import { getNaturalWorktreeIds } from './natural-worktree-ids'

const item = (id: string, sectionKey: string) => ({
  type: 'item' as const,
  sectionKey,
  worktree: { id }
})

describe('getNaturalWorktreeIds', () => {
  it('collects item rows outside the pinned section', () => {
    expect([...getNaturalWorktreeIds([item('a', 'group-1'), item('b', 'group-2')])]).toEqual([
      'a',
      'b'
    ])
  })

  it('excludes a pinned duplicate that also renders in its natural group', () => {
    const rows = [item('a', PINNED_GROUP_KEY), item('a', 'group-1'), item('b', PINNED_GROUP_KEY)]

    const ids = getNaturalWorktreeIds(rows)

    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(false)
  })

  it('ignores every non-item row type', () => {
    const rows = [
      { type: 'header', key: 'k' },
      { type: 'host-header' },
      { type: 'imported-worktrees-card' },
      { type: 'new-external-worktrees-inbox' },
      { type: 'pending-creation' },
      { type: 'folder-workspace' },
      item('a', 'group-1')
    ]

    expect([...getNaturalWorktreeIds(rows)]).toEqual(['a'])
  })

  it('returns an empty set for no rows', () => {
    expect(getNaturalWorktreeIds([]).size).toBe(0)
  })
})
