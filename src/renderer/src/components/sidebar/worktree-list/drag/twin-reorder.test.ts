import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { createHostScopedRepoOf } from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import {
  NO_LIVE_SMART_SORT_SOURCES,
  rankWorktreesForSort
} from '../../../../../../shared/sidebar-list/smart-sort'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { computeVisibleWorktrees } from '../../compute-visible-worktrees'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import {
  buildManualOrderUpdatesForGroupDrop,
  buildManualOrderUpdatesForVisibleGroups
} from '../../worktree-manual-order'
import { buildWorktreeManualOrderCatalog } from '../../worktree-manual-order-catalog'
import { collectDropWrites, dropWriteRows } from './dragged-worktree-copies'
import { getWorktreeDragGroups } from './groups'

// Per-workspace VMs cloned from one base share the repo id and path, so every primary has the same id.
const REPO_ID = 'repo-teal'
const TWIN_ID = `${REPO_ID}::/home/dev/teal`
const HOSTS = ['ssh:vm-a', 'ssh:vm-b', 'ssh:vm-c'] as const satisfies readonly ExecutionHostId[]
const repos: Repo[] = HOSTS.map((hostId) => ({
  ...repo,
  id: REPO_ID,
  path: '/home/dev/teal',
  displayName: 'teal',
  connectionId: hostId.slice('ssh:'.length)
}))
const repoMap = new Map([[REPO_ID, repos[0]!]])

function primary(hostId: ExecutionHostId, manualOrder: number): Worktree {
  return {
    ...worktree,
    id: TWIN_ID,
    repoId: REPO_ID,
    path: '/home/dev/teal',
    hostId,
    isMainWorktree: true,
    displayName: hostId,
    manualOrder
  }
}

/** The window's Manual path: rank, filter, plan rows, then read the cards' hosts in order. */
function renderedHosts(worktrees: Worktree[]): string[] {
  const sortedKeys = rankWorktreesForSort({
    worktrees: [...worktrees],
    sortBy: 'manual',
    latched: false,
    repoMap,
    now: 0,
    sources: NO_LIVE_SMART_SORT_SOURCES
  }).sorted.map(getWorktreeHostIdentity)
  const visible = computeVisibleWorktrees({ [REPO_ID]: worktrees }, sortedKeys, {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    worktreeIdsWithLiveAgent: new Set(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: 'local',
    worktreeLineageById: {},
    sortedByHostIdentity: true
  })
  return planRows(visible).flatMap((row) => (row.type === 'item' ? [row.worktree.hostId!] : []))
}

function planRows(worktrees: Worktree[]) {
  return planSidebarRows({
    groupBy: 'repo',
    worktrees,
    repoMap,
    repoOfWorktree: createHostScopedRepoOf(repos, repoMap),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: false,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set())
}

/** Drop one card at a slot the way the sidebar commits it, and apply the writes it would send. */
function dropCard(worktrees: Worktree[], hostId: ExecutionHostId, dropIndex: number) {
  const groups = getWorktreeDragGroups(planRows(worktrees))
  const catalog = buildWorktreeManualOrderCatalog({ worktrees, folderWorkspaces: [] })
  const dragged = worktrees.find((row) => row.hostId === hostId)!
  const result = buildManualOrderUpdatesForVisibleGroups({
    groups,
    sourceGroupKey: groups[0]!.key,
    draggedIds: [getWorktreeHostIdentity(dragged)],
    dropIndex,
    now: 1_000_000,
    rankByWorktreeId: catalog.rankByKey,
    allWorktreeIds: catalog.orderedKeys
  })
  const writes = collectDropWrites({
    rowsFor: dropWriteRows(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dropWriteRows reads only these two slices.
      { worktreesByRepo: { [REPO_ID]: worktrees }, folderWorkspaces: [] } as never,
      [{ id: dragged.id, hostId: dragged.hostId }]
    ),
    statusIds: [],
    status: null,
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    orderUpdatesByKey: result.updates
  })
  const applied = worktrees.map((row) => {
    const write = writes.find((entry) => entry.executionHostId === row.hostId)
    return write ? { ...row, ...write.updates } : row
  })
  return { groups, writes, applied }
}

describe('reordering same-id primaries on separate machines', () => {
  const twins = [primary('ssh:vm-a', 300), primary('ssh:vm-b', 200), primary('ssh:vm-c', 100)]

  it('renders each copy at its own rank', () => {
    expect(renderedHosts(twins)).toEqual(['ssh:vm-a', 'ssh:vm-b', 'ssh:vm-c'])
    expect(renderedHosts([twins[2]!, twins[0]!, twins[1]!])).toEqual([
      'ssh:vm-a',
      'ssh:vm-b',
      'ssh:vm-c'
    ])
  })

  it('gives every copy its own drag slot', () => {
    const { groups } = dropCard(twins, 'ssh:vm-c', 0)
    expect(groups[0]!.worktreeIds).toEqual(HOSTS.map((hostId) => `${hostId}|${TWIN_ID}`))
  })

  it('moves the dropped copy to the top and writes only that copy', () => {
    const { writes, applied } = dropCard(twins, 'ssh:vm-c', 0)

    expect(writes.map((entry) => entry.executionHostId)).toEqual(['ssh:vm-c'])
    expect(renderedHosts(applied)).toEqual(['ssh:vm-c', 'ssh:vm-a', 'ssh:vm-b'])
  })

  it('moves a copy down past its twins', () => {
    const { applied } = dropCard(twins, 'ssh:vm-a', 3)

    expect(renderedHosts(applied)).toEqual(['ssh:vm-b', 'ssh:vm-c', 'ssh:vm-a'])
  })

  it('materializes a rank for every copy when none has one yet', () => {
    const unranked = twins.map(({ manualOrder: _manualOrder, ...row }, index) => ({
      ...row,
      sortOrder: 30 - index * 10
    }))
    const { writes, applied } = dropCard(unranked, 'ssh:vm-b', 0)

    expect(writes.map((entry) => entry.executionHostId).sort()).toEqual([...HOSTS])
    expect(renderedHosts(applied)).toEqual(['ssh:vm-b', 'ssh:vm-a', 'ssh:vm-c'])
  })

  it('places a board drop next to the lower copy, writing only the dragged card', () => {
    // Lane a, vm-a copy, b, c, vm-b copy, d: the copies sit apart after a sidebar reorder.
    const card = (name: string, manualOrder: number): Worktree => ({
      ...worktree,
      id: `${REPO_ID}::/w/${name}`,
      repoId: REPO_ID,
      path: `/w/${name}`,
      hostId: 'ssh:vm-a',
      displayName: name,
      manualOrder
    })
    const lane = [
      card('a', 0),
      primary('ssh:vm-a', -1_000),
      card('b', -2_000),
      card('c', -3_000),
      primary('ssh:vm-b', -3_500),
      card('d', -4_000)
    ]
    const catalog = buildWorktreeManualOrderCatalog({ worktrees: lane, folderWorkspaces: [] })
    const drop = (dropIndex: number) =>
      buildManualOrderUpdatesForGroupDrop({
        groups: [{ key: 'todo', worktreeIds: lane.map(getWorktreeHostIdentity) }],
        targetGroupKey: 'todo',
        draggedIds: [getWorktreeHostIdentity(lane[0]!)],
        dropIndex,
        now: 2_000_000,
        rankByWorktreeId: catalog.rankByKey,
        allWorktreeIds: catalog.orderedKeys
      })

    // Just below the vm-b copy: between it and d.
    expect([...drop(5).updates]).toEqual([
      [getWorktreeHostIdentity(lane[0]!), { manualOrder: -3_750 }]
    ])
    // Between c and the vm-b copy: still sparse, no full reindex.
    expect([...drop(4).updates]).toEqual([
      [getWorktreeHostIdentity(lane[0]!), { manualOrder: -3_250 }]
    ])
  })
})
