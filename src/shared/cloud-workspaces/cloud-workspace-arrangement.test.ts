import { describe, expect, it } from 'vitest'
import {
  EMPTY_CLOUD_WORKSPACE_PREFS,
  type CloudWorkspacePrefsDocument
} from './cloud-workspaces-wire'
import {
  arrangeCloudWorkspaces,
  dropOnto,
  moveSection,
  nudge,
  reorderGroup,
  setCollapsed,
  setPinned
} from './cloud-workspace-arrangement'

const id = (n: number) => `sbx_${String(n).padStart(24, '0')}`
function ws(n: number, section: string | null = null, archived = false) {
  return { id: id(n), section, archivedAt: archived ? 1 : null }
}
const doc = (patch: Partial<CloudWorkspacePrefsDocument>): CloudWorkspacePrefsDocument => ({
  ...EMPTY_CLOUD_WORKSPACE_PREFS,
  ...patch
})
const shape = (groups: ReturnType<typeof arrangeCloudWorkspaces>) =>
  groups.map((g) => [g.key, g.rows.map((w) => Number(w.id.slice(4))), g.collapsed])

describe('arrangeCloudWorkspaces', () => {
  const rows = [ws(1, 'B'), ws(2), ws(3, 'A'), ws(4, 'B'), ws(5, null, true)]

  it('keeps the server order and sorts sections by name with No section last, by default', () => {
    expect(shape(arrangeCloudWorkspaces(rows, EMPTY_CLOUD_WORKSPACE_PREFS))).toEqual([
      ['section:A', [3], false],
      ['section:B', [1, 4], false],
      ['none', [2, 5], false]
    ])
  })

  it('puts pins on top in pin order, follows manual and section order, and collapses', () => {
    const prefs = doc({
      pinned: [id(4), id(9), id(2), id(5)],
      order: [id(3)],
      sections: ['B', 'A'],
      collapsed: ['A']
    })
    expect(shape(arrangeCloudWorkspaces(rows, prefs))).toEqual([
      // id 5 is archived: it keeps its pin but never sits in Pinned.
      ['pinned', [4, 2], false],
      ['section:B', [1], false],
      ['section:A', [3], true],
      ['none', [5], false]
    ])
  })
})

describe('arrangement edits', () => {
  it('pins to the bottom of Pinned and leaves the manual order', () => {
    const start = doc({ pinned: [id(1)], order: [id(2), id(3)] })
    expect(setPinned(start, id(2), true)).toEqual(doc({ pinned: [id(1), id(2)], order: [id(3)] }))
    expect(setPinned(start, id(1), false)).toEqual(doc({ order: [id(2), id(3)] }))
    expect(setPinned(start, id(1), true)).toBe(start)
  })

  it('reorders a group without disturbing ids it does not show', () => {
    const start = doc({ pinned: [id(1), id(2), id(3)], order: [id(7), id(8), id(9)] })
    expect(reorderGroup(start, { kind: 'pinned' }, [id(3), id(1)]).pinned).toEqual([
      id(3),
      id(1),
      id(2)
    ])
    expect(reorderGroup(start, { kind: 'section' }, [id(9), id(5)]).order).toEqual([
      id(9),
      id(5),
      id(7),
      id(8)
    ])
  })

  it('moves rows by one place and onto another row', () => {
    expect(nudge(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
    expect(nudge(['a', 'b', 'c'], 'a', -1)).toBeNull()
    expect(dropOnto(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(dropOnto(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(dropOnto(['a', 'b'], 'a', 'a')).toBeNull()
  })

  it('orders sections among those shown and toggles collapse', () => {
    const start = doc({ sections: ['Old'] })
    expect(moveSection(start, ['A', 'B'], 'B', -1)?.sections).toEqual(['B', 'A', 'Old'])
    expect(moveSection(start, ['A', 'B'], 'A', -1)).toBeNull()
    expect(setCollapsed(start, 'A', true).collapsed).toEqual(['A'])
    expect(setCollapsed(doc({ collapsed: ['A'] }), 'A', false).collapsed).toEqual([])
  })
})
