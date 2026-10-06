// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'
import { useSidebarSectionRows } from './worktree-list/listing/use-section-rows'
import { expandGroupsForWorktreeReveal } from './worktree-list/navigation/pending-reveal-inputs'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeGroupBy } from './worktree-list/grouping/row-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'

afterEach(cleanup)
const projectGrouping = { projects: [], projectHostSetups: [] }
const settings = useAppStore.getState().settings
const workspaceStatuses = cloneDefaultWorkspaceStatuses()
const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
  count: 0,
  getScrollElement: () => null,
  estimateSize: () => 40,
  scrollToFn: vi.fn(),
  observeElementRect: vi.fn(),
  observeElementOffset: vi.fn()
})

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
  lineageById: Record<string, WorktreeLineage> = {},
  visibleWorkspaceHostIds: ExecutionHostId[] | null = ['local', hostId]
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
      visibleWorkspaceHostIds,
      workspaceHostScope: 'all'
    })
  ).result.current.sectionRows
}

for (const hostId of ['ssh:builder', 'runtime:builder'] as const) {
  for (const [groupBy, laneKey] of [
    ['none', 'all'],
    ['workspace-status', 'workspace-status:in-progress'],
    ['pr-status', 'pr:in-progress']
  ] as const) {
    it(`${hostId} ${groupBy}: revealing remote should preserve collapsed local lane`, () => {
      const { local, remote, repoMap } = setup(hostId)
      const worktrees = [local, remote]
      const collapsedGroups = new Set([laneKey, `${laneKey}:host:${hostId}`])
      const rows = sections(hostId, groupBy, worktrees, collapsedGroups)
      expect(rows.filter((row) => row.type === 'header' && row.key === laneKey)).toHaveLength(2)
      expect(rows.filter((row) => row.type === 'item')).toHaveLength(0)
      expandGroupsForWorktreeReveal(
        {
          pendingRevealWorktree: null,
          pendingRevealSidebarRow: null,
          clearPendingRevealWorktreeId: vi.fn(),
          clearPendingRevealSidebarRow: vi.fn(),
          agentSendTargetWorktreeId: null,
          renderRows: rows,
          virtualizer,
          scrollRef: createRef<HTMLDivElement>(),
          worktrees,
          folderWorkspaces: [],
          repoMap,
          worktreeMap: new Map(worktrees.map((worktree) => [worktree.id, worktree])),
          worktreeLineageById: {},
          collapsedGroups,
          toggleGroup: (key) => {
            if (collapsedGroups.has(key)) {
              collapsedGroups.delete(key)
            } else {
              collapsedGroups.add(key)
            }
          },
          groupBy,
          pinnedDisplayPolicy: 'single-location',
          defaultHostId: 'local',
          prCache: null,
          workspaceStatuses,
          settings,
          projectGroups: [],
          projectGrouping,
          flashRevealedRow: vi.fn(),
          markRevealScroll: vi.fn(),
          schedulePendingRevealFrame: vi.fn(),
          cancelPendingRevealFrames: vi.fn()
        },
        remote.id,
        hostId
      )
      const after = sections(hostId, groupBy, worktrees, collapsedGroups)
      expect(after.some((row) => row.type === 'item' && row.worktree.id === remote.id)).toBe(true)
      expect(after.some((row) => row.type === 'item' && row.worktree.id === local.id)).toBe(false)
    })
    it(`${hostId} ${groupBy}: combined view retains its single section collapse key`, () => {
      const { local, remote } = setup(hostId)
      const worktrees = [local, remote]
      const rows = sections(hostId, groupBy, worktrees, new Set([laneKey]), {}, null)
      expect(rows.filter((row) => row.type === 'header' && row.key === laneKey)).toHaveLength(1)
      expect(rows.some((row) => row.type === 'item')).toBe(false)
      const expanded = sections(
        hostId,
        groupBy,
        worktrees,
        new Set([`${laneKey}:host:${hostId}`]),
        {},
        null
      )
      expect(expanded.filter((row) => row.type === 'item')).toHaveLength(2)
      expect(expanded.some((row) => row.type === 'header' && row.collapseKey !== undefined)).toBe(
        false
      )
    })
  }
}
