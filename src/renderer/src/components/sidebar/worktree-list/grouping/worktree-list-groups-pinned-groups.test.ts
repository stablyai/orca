import { describe, expect, it } from 'vitest'
import type { PinnedGroupSettings } from '../../../../../../shared/pinned-groups'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import { scopeHostSectionCollapse } from '../../../../../../shared/sidebar-list/host-section-collapse'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeLineage } from '../../../../store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { worktree, repoMap } from './worktree-list-groups-test-fixtures'

const groups = [
  { id: 'later', name: 'Later', order: 8 },
  { id: 'fleet', name: 'Fleet', order: 2 }
]
const pinned = (id: string): Worktree => ({ ...worktree, id, isPinned: true, hostId: 'local' })

function rows(worktrees: Worktree[], settings: PinnedGroupSettings, collapsed: string[] = []) {
  return planSidebarRows({
    ...settings,
    groupBy: 'none',
    sortBy: 'manual',
    worktrees,
    repoMap,
    prGroupOf: () => 'in-progress',
    workspaceStatuses: [],
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: true,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set(collapsed))
}

const settings = {
  pinnedGroups: groups,
  pinnedGroupByWorktreeIdentity: { 'local|a': 'later', 'local|b': 'fleet' }
}

describe('pin groups', () => {
  it('places ungrouped pins first, then groups by order with nested rows', () => {
    expect(rows([pinned('a'), pinned('free'), pinned('b')], settings)).toMatchObject([
      { type: 'header', key: 'pinned', count: 3 },
      { type: 'item', worktree: { id: 'free' }, groupDepth: 0, sectionKey: 'pinned' },
      {
        type: 'header',
        key: 'pinned-group:fleet',
        label: 'Fleet',
        collapseKey: 'pinned-group:fleet',
        projectGroupDepth: 1,
        count: 1,
        worktreeIds: ['b']
      },
      { type: 'item', worktree: { id: 'b' }, groupDepth: 1, sectionKey: 'pinned' },
      { type: 'header', key: 'pinned-group:later', count: 1 },
      { type: 'item', worktree: { id: 'a' }, groupDepth: 1 }
    ])
  })

  it('keeps a collapsed group header and hides its rows', () => {
    const result = rows([pinned('a'), pinned('b')], settings, ['pinned-group:fleet'])
    expect(
      result.map((row) =>
        row.type === 'item' ? row.worktree.id : row.type === 'header' ? row.key : ''
      )
    ).toEqual(['pinned', 'pinned-group:fleet', 'pinned-group:later', 'a'])
    expect(rows([pinned('a')], settings, ['pinned'])).toMatchObject([
      { type: 'header', key: 'pinned' }
    ])
  })

  it('treats stale membership as ungrouped and leaves unpinned rows in their natural section', () => {
    const result = rows([pinned('a'), { ...pinned('b'), isPinned: false }], {
      pinnedGroups: [],
      pinnedGroupByWorktreeIdentity: { 'local|a': 'deleted', 'local|b': 'deleted' }
    })
    expect(result).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'item', worktree: { id: 'a' }, groupDepth: 0 },
      { type: 'header', key: 'all' },
      { type: 'item', worktree: { id: 'b' }, groupDepth: 0 }
    ])
  })

  it('keeps descendants in their pinned ancestor group even with their own membership', () => {
    const parent = { ...pinned('a'), instanceId: 'parent-instance' }
    const child = {
      ...pinned('b'),
      isPinned: false,
      instanceId: 'child-instance',
      lineage: makeLineage({ worktreeId: 'b', parentWorktreeId: 'a' })
    }
    const result = rows([child, parent], settings)
    expect(result.filter((row) => row.type === 'item')).toMatchObject([
      { worktree: { id: 'a' }, groupDepth: 1, depth: 0 },
      { worktree: { id: 'b' }, groupDepth: 1, depth: 1 }
    ])
    expect(
      result.find((row) => row.type === 'header' && row.key === 'pinned-group:later')
    ).toMatchObject({ count: 2, worktreeIds: ['a', 'b'] })
    expect(
      rows([child, parent], settings, ['pinned-group:later']).filter((row) => row.type === 'item')
    ).toEqual([])
  })

  it('groups identical worktree IDs independently on different hosts', () => {
    const result = rows([pinned('a'), { ...pinned('a'), hostId: 'runtime:orion' }], {
      pinnedGroups: groups,
      pinnedGroupByWorktreeIdentity: { 'local|a': 'fleet', 'runtime:orion|a': 'later' }
    })
    expect(result.filter((row) => row.type === 'item')).toMatchObject([
      { worktree: { id: 'a', hostId: 'local' }, groupDepth: 1 },
      { worktree: { id: 'a', hostId: 'runtime:orion' }, groupDepth: 1 }
    ])
    expect(
      result.filter((row) => row.type === 'header').map((row) => [row.key, row.count])
    ).toEqual([
      ['pinned', 2],
      ['pinned-group:fleet', 1],
      ['pinned-group:later', 1]
    ])
  })

  it('retains the Pinned parent on each explicit host section and respects parent collapse', () => {
    const grouped = rows([pinned('b'), { ...pinned('a'), hostId: 'runtime:orion' }], {
      ...settings,
      pinnedGroupByWorktreeIdentity: { 'local|b': 'fleet', 'runtime:orion|a': 'fleet' }
    })
    const sectioned = addHostSectionRows({
      rows: grouped,
      hostOptions: [
        { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
        { id: 'runtime:orion', kind: 'runtime', label: 'Orion', detail: '', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      localHostLabel: 'Local'
    })
    expect(sectioned.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'pinned',
      'pinned-group:fleet',
      'pinned',
      'pinned-group:fleet'
    ])
    const collapsed = scopeHostSectionCollapse({
      rows: sectioned,
      collapsedGroups: new Set(['pinned:host:runtime:orion'])
    })
    expect(
      collapsed.filter((row) => row.type === 'item').map((row) => row.worktree.hostId)
    ).toEqual(['local'])
    expect(collapsed.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'pinned',
      'pinned-group:fleet',
      'pinned'
    ])
  })
})
