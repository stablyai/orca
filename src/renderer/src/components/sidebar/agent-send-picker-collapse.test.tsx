// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'
import { useEffectiveCollapsedGroups } from './worktree-list/listing/use-collapsed-groups'
import { useSidebarSectionRows } from './worktree-list/listing/use-section-rows'
import { getWorktreeLineageGroupKey } from './worktree-list/grouping/group-keys'
import { getWorktreeLineageAncestors } from './worktree-lineage-projection'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeGroupBy } from './worktree-list/grouping/row-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'

afterEach(cleanup)
const projectGrouping = { projects: [], projectHostSetups: [] }
const settings = useAppStore.getState().settings
const workspaceStatuses = cloneDefaultWorkspaceStatuses()
function setup(hostId: ExecutionHostId) {
  const localRepo = makeRepo()
  const remoteRepo = { ...localRepo, id: 'remote-repo', executionHostId: hostId }
  const repoMap = new Map([
    [localRepo.id, localRepo],
    [remoteRepo.id, remoteRepo]
  ])
  const local = {
    ...makeWorktree({
      id: 'local',
      displayName: 'Local',
      branch: 'local',
      sortOrder: 0,
      instanceId: 'local-instance'
    }),
    hostId: 'local' as const
  }
  const remote = {
    ...local,
    id: 'remote',
    instanceId: 'remote-instance',
    repoId: remoteRepo.id,
    hostId
  }
  return { localRepo, remoteRepo, repoMap, local, remote }
}

function sections(
  hostId: ExecutionHostId,
  groupBy: WorktreeGroupBy,
  worktrees: Worktree[],
  collapsedGroups: Set<string>,
  lineageById: Record<string, WorktreeLineage> = {}
) {
  const { localRepo, remoteRepo, repoMap } = setup(hostId)
  return renderHook(() =>
    useSidebarSectionRows({
      groupBy,
      projectOrderBy: 'manual',
      pinnedDisplayPolicy: 'single-location',
      defaultHostId: 'local',
      worktrees,
      repos: [localRepo, remoteRepo],
      repoMap,
      worktreeMap: new Map(worktrees.map((worktree) => [worktree.id, worktree])),
      worktreeLineageById: lineageById,
      prCache: null,
      settings,
      workspaceStatuses,
      effectiveCollapsedGroups: collapsedGroups,
      projectGrouping,
      visibleReposForRows: [localRepo, remoteRepo],
      visibleProjectGroupsForRows: [],
      visibleFolderWorkspacesForRows: [],
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      filterRepoIds: [],
      visibleWorkspaceHostIds: ['local', hostId],
      workspaceHostScope: 'all'
    })
  ).result.current.sectionRows
}

for (const hostId of ['ssh:builder', 'runtime:builder'] as const) {
  it(`${hostId}: agent picker should expose a target within a collapsed host`, () => {
    const { local, remote, repoMap } = setup(hostId)
    const worktrees = [local, remote]
    const collapsedGroups = new Set([`host:${hostId}`, 'host:local'])
    const { result } = renderHook(() =>
      useEffectiveCollapsedGroups({
        hostScopedGroups: true,
        collapsedGroups,
        agentSendTargetWorktreeId: remote.id,
        groupBy: 'none',
        pinnedDisplayPolicy: 'single-location',
        worktrees,
        visibleWorktrees: worktrees,
        repoMap,
        worktreeMap: new Map(worktrees.map((worktree) => [worktree.id, worktree])),
        worktreeLineageById: {},
        prCache: null,
        workspaceStatuses,
        settings,
        projectGroups: [],
        projectGrouping,
        folderWorkspaces: [],
        defaultHostId: 'local'
      })
    )
    expect([...collapsedGroups]).toEqual([`host:${hostId}`, 'host:local'])
    expect(result.current.has('host:local')).toBe(true)
    const rows = sections(hostId, 'none', worktrees, result.current)
    expect(rows.some((row) => row.type === 'host-header' && row.hostId === hostId)).toBe(true)
    expect(
      sections(hostId, 'none', worktrees, new Set()).some(
        (row) => row.type === 'item' && row.worktree.id === remote.id
      )
    ).toBe(true)
    expect(rows.some((row) => row.type === 'item' && row.worktree.id === remote.id)).toBe(true)
  })
}

for (const hostId of ['local', 'ssh:builder', 'runtime:builder'] as const) {
  it(`${hostId}: agent picker should expose child under a collapsed parent`, () => {
    const { local, remote, repoMap } = setup(hostId)
    const parent = hostId === 'local' ? local : remote
    if (!parent.instanceId) {
      throw new Error('Fixture parent instance missing')
    }
    const child = { ...parent, id: 'child', instanceId: 'child-instance', sortOrder: 1 }
    const worktrees = [parent, child]
    const lineage: WorktreeLineage = {
      worktreeId: child.id,
      worktreeInstanceId: child.instanceId,
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: 1
    }
    const worktreeLineageById = { [child.id]: lineage }
    const worktreeMap = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
    expect(getWorktreeLineageAncestors(child, worktreeLineageById, worktreeMap)).toEqual([parent])
    const collapsedGroups = new Set([getWorktreeLineageGroupKey(parent)])
    expect(
      sections(hostId, 'none', worktrees, collapsedGroups, worktreeLineageById).some(
        (row) => row.type === 'item' && row.worktree.id === child.id
      )
    ).toBe(false)
    expect(
      sections(hostId, 'none', worktrees, new Set(), worktreeLineageById).some(
        (row) => row.type === 'item' && row.worktree.id === child.id
      )
    ).toBe(true)
    const { result } = renderHook(() =>
      useEffectiveCollapsedGroups({
        hostScopedGroups: true,
        collapsedGroups,
        agentSendTargetWorktreeId: child.id,
        groupBy: 'none',
        pinnedDisplayPolicy: 'single-location',
        worktrees,
        visibleWorktrees: worktrees,
        repoMap,
        worktreeMap,
        worktreeLineageById,
        prCache: null,
        workspaceStatuses,
        settings,
        projectGroups: [],
        projectGrouping,
        folderWorkspaces: [],
        defaultHostId: 'local'
      })
    )
    expect(collapsedGroups.has(getWorktreeLineageGroupKey(parent))).toBe(true)
    const after = sections(hostId, 'none', worktrees, result.current, worktreeLineageById)
    expect(after.some((row) => row.type === 'item' && row.worktree.id === child.id)).toBe(true)
  })
}

it('opens a filtered parent chain and owning lane, then restores the saved set on close', () => {
  const { local, remote, repoMap } = setup('ssh:builder')
  const root = { ...remote, instanceId: 'root-instance', isPinned: true }
  const parent = { ...remote, id: 'parent', instanceId: 'parent-instance', isPinned: false }
  const child = { ...remote, id: 'child', instanceId: 'child-instance', isPinned: false }
  const worktrees = [local, root, parent, child]
  const lineage = (worktree: typeof child, ancestor: typeof root): WorktreeLineage => ({
    worktreeId: worktree.id,
    worktreeInstanceId: worktree.instanceId,
    parentWorktreeId: ancestor.id,
    parentWorktreeInstanceId: ancestor.instanceId,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  })
  const collapsedGroups = new Set([
    'host:ssh:builder',
    'lineage:ssh:builder|remote',
    'lineage:ssh:builder|parent',
    'all:host:ssh:builder',
    'all',
    'pinned:host:ssh:builder',
    'host:local',
    'lineage:local|parent'
  ])
  const initialProps: { targetId: string | null } = { targetId: child.id }
  const { result, rerender } = renderHook(
    ({ targetId }: { targetId: string | null }) =>
      useEffectiveCollapsedGroups({
        hostScopedGroups: true,
        collapsedGroups,
        agentSendTargetWorktreeId: targetId,
        groupBy: 'none',
        pinnedDisplayPolicy: 'single-location',
        worktrees,
        visibleWorktrees: [local, child],
        repoMap,
        worktreeMap: new Map(worktrees.map((worktree) => [worktree.id, worktree])),
        worktreeLineageById: {
          [parent.id]: lineage(parent, root),
          [child.id]: lineage(child, parent)
        },
        prCache: null,
        workspaceStatuses,
        settings,
        projectGroups: [],
        projectGrouping,
        folderWorkspaces: [],
        defaultHostId: 'local'
      }),
    { initialProps }
  )
  expect([...result.current]).toEqual([
    'all',
    'pinned:host:ssh:builder',
    'host:local',
    'lineage:local|parent'
  ])
  expect(collapsedGroups.size).toBe(8)
  rerender({ targetId: null })
  expect(result.current).toBe(collapsedGroups)
})
