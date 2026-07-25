import { describe, expect, it } from 'vitest'
import {
  PANEL_TREE_ROOT_NODES,
  canReparentPanelTreeGroup,
  childrenOfGroup,
  createPanelTreeGroup,
  deletePanelTreeGroup,
  migrateLegacyPanelGroups,
  movePanelInTree,
  normalizePanelTreeGroups,
  panelTreeGroupDepth,
  panelTreeGroupPath,
  renamePanelTreeGroup
} from './panel-tree'

describe('normalizePanelTreeGroups', () => {
  it('drops bad roots and empty titles', () => {
    expect(
      normalizePanelTreeGroups([
        { id: '1', title: 'ok', root: 'nodes', parentId: null, order: 0 },
        { id: '2', title: '  ', root: 'nodes', parentId: null, order: 1 },
        { id: '3', title: 'x', root: 'nope', parentId: null, order: 2 }
      ])
    ).toEqual([{ id: '1', title: 'ok', root: 'nodes', parentId: null, order: 0 }])
  })
})

describe('migrateLegacyPanelGroups', () => {
  it('mints groups from terminal group strings', () => {
    const result = migrateLegacyPanelGroups({
      groups: [],
      terminalPanels: [
        { id: 'a', title: 'nvtop', command: 'nvtop', group: 'node-b' },
        { id: 'b', title: 'btop', command: 'btop', group: 'node-b' },
        { id: 'c', title: 'local', command: 'htop' }
      ],
      webPanels: [{ id: 'w', title: 'LF', url: 'https://x.example/' }]
    })
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].title).toBe('node-b')
    expect(result.groups[0].root).toBe(PANEL_TREE_ROOT_NODES)
    expect(result.terminalPanels[0].groupId).toBe(result.groups[0].id)
    expect(result.terminalPanels[2].groupId).toBeUndefined()
  })
})

describe('tree ops', () => {
  it('enforces depth and cycles on reparent', () => {
    let groups = createPanelTreeGroup({
      groups: [],
      root: PANEL_TREE_ROOT_NODES,
      title: 'A'
    })
    const a = groups[0].id
    groups = createPanelTreeGroup({ groups, root: PANEL_TREE_ROOT_NODES, title: 'B', parentId: a })
    const b = groups.find((g) => g.title === 'B')!.id
    groups = createPanelTreeGroup({ groups, root: PANEL_TREE_ROOT_NODES, title: 'C', parentId: b })
    const c = groups.find((g) => g.title === 'C')!.id
    expect(panelTreeGroupDepth(groups, c)).toBe(2)
    // Depth 3 would exceed max 3 (0,1,2 allowed for leaves of depth)
    expect(
      createPanelTreeGroup({
        groups,
        root: PANEL_TREE_ROOT_NODES,
        title: 'D',
        parentId: c
      }).find((g) => g.title === 'D')
    ).toBeUndefined()
    expect(canReparentPanelTreeGroup(groups, a, b)).toBe(false)
  })

  it('moves panels across groups and rehomes on delete', () => {
    const groups = createPanelTreeGroup({
      groups: [],
      root: PANEL_TREE_ROOT_NODES,
      title: 'G1'
    })
    const g1 = groups[0].id
    const withG2 = createPanelTreeGroup({
      groups,
      root: PANEL_TREE_ROOT_NODES,
      title: 'G2'
    })
    const g2 = withG2.find((g) => g.title === 'G2')!.id
    const panels = [
      { id: 'p1', groupId: g1, order: 0 },
      { id: 'p2', groupId: g1, order: 1 },
      { id: 'p3', groupId: g2, order: 0 }
    ]
    const moved = movePanelInTree(panels, 'p1', 'p3', g2)
    expect(moved.find((p) => p.id === 'p1')?.groupId).toBe(g2)
    const deleted = deletePanelTreeGroup({
      groups: withG2,
      groupId: g2,
      terminalPanels: moved,
      webPanels: []
    })
    expect(deleted.groups.map((g) => g.id)).toEqual([g1])
    expect(deleted.terminalPanels.every((p) => p.groupId !== g2)).toBe(true)
  })

  it('renames groups', () => {
    const groups = createPanelTreeGroup({
      groups: [],
      root: PANEL_TREE_ROOT_NODES,
      title: 'Old'
    })
    const next = renamePanelTreeGroup(groups, groups[0].id, 'New')
    expect(next[0].title).toBe('New')
  })

  it('lists children', () => {
    let groups = createPanelTreeGroup({
      groups: [],
      root: PANEL_TREE_ROOT_NODES,
      title: 'Root'
    })
    const rootId = groups[0].id
    groups = createPanelTreeGroup({
      groups,
      root: PANEL_TREE_ROOT_NODES,
      title: 'Child',
      parentId: rootId
    })
    expect(childrenOfGroup(groups, PANEL_TREE_ROOT_NODES, rootId).map((g) => g.title)).toEqual([
      'Child'
    ])
  })
})

describe('panelTreeGroupPath', () => {
  const groups = [
    { id: 'g1', root: PANEL_TREE_ROOT_NODES, parentId: null, title: 'node-a', order: 0 },
    { id: 'g2', root: PANEL_TREE_ROOT_NODES, parentId: 'g1', title: 'gpu', order: 0 }
  ]

  it('returns an empty path for no group', () => {
    expect(panelTreeGroupPath(groups, null)).toEqual([])
    expect(panelTreeGroupPath(groups, undefined)).toEqual([])
  })

  it('returns an empty path for an unknown id', () => {
    expect(panelTreeGroupPath(groups, 'nope')).toEqual([])
  })

  it('returns outermost-first titles for a nested group', () => {
    expect(panelTreeGroupPath(groups, 'g2')).toEqual(['node-a', 'gpu'])
    expect(panelTreeGroupPath(groups, 'g1')).toEqual(['node-a'])
  })

  it('returns an empty path instead of hanging on a cycle', () => {
    const cyclic = [
      { id: 'a', root: PANEL_TREE_ROOT_NODES, parentId: 'b', title: 'A', order: 0 },
      { id: 'b', root: PANEL_TREE_ROOT_NODES, parentId: 'a', title: 'B', order: 0 }
    ]
    expect(panelTreeGroupPath(cyclic, 'a')).toEqual([])
  })
})
