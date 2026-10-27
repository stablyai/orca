import { describe, expect, it } from 'vitest'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../../../shared/tab-types'
import { findNeighbor, pickAdjacentEditorOpenGroupId } from './editor-open-adjacent-group'

const FILE_ID = '/repo/src/main.ts'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const columns = (
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode,
  ratio?: number
): TabGroupLayoutNode => ({ type: 'split', direction: 'horizontal', first, second, ratio })
const rows = (
  first: TabGroupLayoutNode,
  second: TabGroupLayoutNode,
  ratio?: number
): TabGroupLayoutNode => ({ type: 'split', direction: 'vertical', first, second, ratio })

function tab(id: string, groupId: string, contentType: Tab['contentType'], entityId = id): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: 'wt-1',
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

type Fixture = {
  /** Groups whose selected tab is an editor (other than the file); the rest show a terminal. */
  editors?: string[]
  /** Groups holding an unselected tab of the file. */
  withFile?: string[]
  /** Groups holding an unselected, unrelated editor tab behind their terminal. */
  inactiveEditors?: string[]
}

function collectGroupIds(node: TabGroupLayoutNode): string[] {
  return node.type === 'leaf'
    ? [node.groupId]
    : [...collectGroupIds(node.first), ...collectGroupIds(node.second)]
}

function buildState(layout: TabGroupLayoutNode, fixture: Fixture = {}) {
  const groups: TabGroup[] = []
  const tabs: Tab[] = []
  for (const groupId of collectGroupIds(layout)) {
    const active = fixture.editors?.includes(groupId)
      ? tab(`${groupId}-editor`, groupId, 'editor')
      : tab(`${groupId}-terminal`, groupId, 'terminal')
    tabs.push(active)
    if (fixture.withFile?.includes(groupId)) {
      tabs.push(tab(`${groupId}-file`, groupId, 'editor', FILE_ID))
    }
    if (fixture.inactiveEditors?.includes(groupId)) {
      tabs.push(tab(`${groupId}-old-editor`, groupId, 'editor'))
    }
    groups.push({
      id: groupId,
      worktreeId: 'wt-1',
      activeTabId: active.id,
      tabOrder: tabs.filter((t) => t.groupId === groupId).map((t) => t.id)
    })
  }
  return { groups, tabs }
}

function pick(layout: TabGroupLayoutNode, sourceGroupId: string, fixture?: Fixture) {
  const { groups, tabs } = buildState(layout, fixture)
  return pickAdjacentEditorOpenGroupId({
    layout,
    groups,
    tabs,
    sourceGroupId,
    fileId: FILE_ID,
    contentType: 'editor'
  })
}

describe('pickAdjacentEditorOpenGroupId', () => {
  it('opens across a two-column split in both directions', () => {
    const layout = columns(leaf('A'), leaf('B'))
    expect(pick(layout, 'A')).toBe('B')
    expect(pick(layout, 'B')).toBe('A')
  })

  it('opens across a two-row split in both directions', () => {
    const layout = rows(leaf('A'), leaf('B'))
    expect(pick(layout, 'A')).toBe('B')
    expect(pick(layout, 'B')).toBe('A')
  })

  it('prefers the right neighbor over the left in three columns', () => {
    expect(pick(columns(leaf('A'), columns(leaf('B'), leaf('C'))), 'B')).toBe('C')
  })

  it('ignores the diagonal group in a four-way grid', () => {
    const grid = columns(rows(leaf('TL'), leaf('BL')), rows(leaf('TR'), leaf('BR')))
    expect(pick(grid, 'BR')).toBe('BL')
    // Why: corner-only contact is not adjacency, so TL's editor earns no preference.
    expect(pick(grid, 'BR', { editors: ['TL'] })).toBe('BL')
  })

  it('picks the upper-right group beside a tall source regardless of their height ratio', () => {
    for (const ratio of [0.2, 0.5, 0.8]) {
      expect(pick(columns(leaf('A'), rows(leaf('B'), leaf('C'), ratio)), 'A')).toBe('B')
    }
  })

  it('lets a neighbor showing an editor beat side order', () => {
    expect(pick(columns(leaf('A'), rows(leaf('B'), leaf('C'))), 'A', { editors: ['C'] })).toBe('C')
  })

  it('orders neighbors below a wide source left to right', () => {
    expect(pick(rows(leaf('A'), columns(leaf('L'), leaf('R'))), 'A')).toBe('L')
  })

  it('compares equal-priority editors right, left, below, above', () => {
    const editors = ['L', 'R', 'T', 'B']
    const cross = rows(
      leaf('T'),
      rows(columns(leaf('L'), columns(leaf('S'), leaf('R'))), leaf('B'))
    )
    expect(pick(cross, 'S', { editors })).toBe('R')
    expect(pick(cross, 'S', { editors: ['L', 'T', 'B'] })).toBe('L')
    expect(pick(cross, 'S', { editors: ['T', 'B'] })).toBe('B')
    expect(pick(cross, 'S', { editors: ['T'] })).toBe('T')
  })

  it('reuses a nonadjacent visible group that already holds the file', () => {
    expect(pick(columns(leaf('A'), columns(leaf('B'), leaf('C'))), 'A', { withFile: ['C'] })).toBe(
      'C'
    )
  })

  it('prefers a neighboring view when the file has several', () => {
    const layout = columns(leaf('A'), columns(leaf('B'), columns(leaf('C'), leaf('D'))))
    expect(pick(layout, 'A', { withFile: ['B', 'D'] })).toBe('B')
    expect(pick(layout, 'A', { withFile: ['C', 'D'] })).toBe('C')
  })

  it('opens a second view beside the source when only the source has the file', () => {
    expect(pick(columns(leaf('A'), leaf('B')), 'A', { withFile: ['A'] })).toBe('B')
  })

  it('keeps a single group in place', () => {
    expect(pick(leaf('A'), 'A')).toBe('A')
  })

  it('covers an adjacent agent before a nonadjacent editor without the file', () => {
    expect(pick(columns(leaf('A'), columns(leaf('B'), leaf('C'))), 'A', { editors: ['C'] })).toBe(
      'B'
    )
  })

  it('selects an old unselected matching tab over a nearby editor', () => {
    expect(
      pick(columns(leaf('A'), columns(leaf('B'), leaf('C'))), 'A', {
        editors: ['B'],
        withFile: ['C']
      })
    ).toBe('C')
  })

  it('does not treat an inactive editor tab as showing an editor', () => {
    const layout = columns(leaf('L'), columns(leaf('S'), leaf('R')))
    expect(pick(layout, 'S', { editors: ['L'], inactiveEditors: ['R'] })).toBe('L')
  })

  it('does not match a diff of the same file as a reusable view', () => {
    const layout = columns(leaf('A'), columns(leaf('B'), leaf('C')))
    const { groups, tabs } = buildState(layout)
    tabs.push(tab('C-diff', 'C', 'diff', FILE_ID))
    expect(
      pickAdjacentEditorOpenGroupId({
        layout,
        groups,
        tabs,
        sourceGroupId: 'A',
        fileId: FILE_ID,
        contentType: 'editor'
      })
    ).toBe('B')
  })

  it('is invariant to candidate order', () => {
    const layout = columns(leaf('A'), rows(leaf('B'), leaf('C')))
    const { groups, tabs } = buildState(layout, { editors: ['B', 'C'] })
    const input = { layout, sourceGroupId: 'A', fileId: FILE_ID, contentType: 'editor' as const }
    const forward = pickAdjacentEditorOpenGroupId({ ...input, groups, tabs })
    const reversed = pickAdjacentEditorOpenGroupId({
      ...input,
      groups: groups.toReversed(),
      tabs: tabs.toReversed()
    })
    expect(forward).toBe('B')
    expect(reversed).toBe(forward)
  })

  it('agrees across split histories that draw the same grid', () => {
    const byColumns = columns(rows(leaf('TL'), leaf('BL')), rows(leaf('TR'), leaf('BR')))
    const byRows = rows(columns(leaf('TL'), leaf('TR')), columns(leaf('BL'), leaf('BR')))
    for (const source of ['TL', 'TR', 'BL', 'BR']) {
      expect(pick(byRows, source)).toBe(pick(byColumns, source))
    }
  })

  it('returns null when the source is not a live leaf', () => {
    expect(pick(columns(leaf('A'), leaf('B')), 'gone')).toBeNull()
  })
})

describe('findNeighbor', () => {
  it('requires positive overlap along the shared edge', () => {
    const source = { left: 0, top: 0, right: 0.5, bottom: 0.5 }
    expect(findNeighbor(source, { left: 0.5, top: 0.5, right: 1, bottom: 1 })).toBeNull()
    expect(findNeighbor(source, { left: 0.5, top: 0.25, right: 1, bottom: 1 })).toEqual({
      side: 'right',
      position: 0.25
    })
  })
})
