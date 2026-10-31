// @vitest-environment happy-dom
import { createRef, useRef } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { Virtualizer } from '@tanstack/react-virtual'
import { afterEach, expect, it, vi } from 'vitest'
import * as plans from '../../../../shared/sidebar-list/sidebar-row-plan'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { usePendingSidebarReveal } from './worktree-list/navigation/use-pending-reveal'
import { useSidebarRevealRequests } from './worktree-list/navigation/use-reveal-requests'
import { SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT } from '@/lib/scroll-to-current-workspace-status'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'

const confirmReveal = async () => true
import { getWorktreeOptionId } from './worktree-list/rows/option-dom'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { SectionRowsArgs } from './worktree-list/listing/sidebar-list-model'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'
import { useSidebarSectionRows } from './worktree-list/listing/use-section-rows'
import { expandGroupsForWorktreeReveal } from './worktree-list/navigation/pending-reveal-inputs'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeGroupBy } from '../../../../shared/sidebar-list/row-types'
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

it.each(['custom-row', 'palette-store'] as const)(
  'reveals the actual alias anchor through the production row plan and pending reveal (%s)',
  (entrance) => {
    const previous = useAppStore.getState()
    const planCalls = vi.spyOn(plans, 'planSidebarRows')
    const rootGroup: ProjectGroup = {
      id: 'root',
      name: 'Root',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 0,
      updatedAt: 0
    }
    const childGroup = { ...rootGroup, id: 'child', name: 'Child', parentGroupId: 'root' }
    const otherGroup = { ...rootGroup, id: 'other', name: 'Other', tabOrder: 1 }
    const winner = {
      ...makeRepo(),
      id: 'winner',
      path: '/same',
      upstream: { owner: 'org', repo: 'app' },
      projectGroupId: 'other'
    }
    const alias = { ...winner, id: 'alias', projectGroupId: 'child' }
    const remote = {
      ...makeRepo(),
      id: 'remote',
      path: '/remote',
      executionHostId: 'runtime:builder' as const
    }
    const repos = [alias, winner, remote]
    // The physical representative has a conflicting parent; catalog manual order anchors the header on its alias.
    const projection = projectHostSetupProjectionFromRepos([winner, alias, remote])
    const projectGrouping = { projects: projection.projects, projectHostSetups: projection.setups }
    const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
    const worktreeMap = new Map<string, Worktree>()
    const frames: FrameRequestCallback[] = []
    const schedule = (callback: FrameRequestCallback) => {
      frames.push(callback)
    }
    const cancel = () => {
      frames.length = 0
    }
    const flash = vi.fn()
    const toggle = (key: string) =>
      useAppStore.setState((state) => {
        const next = new Set(state.collapsedGroups)
        next.delete(key)
        return { collapsedGroups: next }
      })
    useAppStore.setState({
      repos,
      projects: [...projection.projects],
      projectHostSetups: [...projection.setups],
      projectGroups: [rootGroup, childGroup, otherGroup],
      pendingRevealSidebarRow: null,
      collapsedGroups: new Set([
        'project-group:root',
        'project-group:child',
        'project-group:other',
        'host:local',
        'host:runtime:builder'
      ])
    })
    const target = getProjectGroupingIndexFromState(useAppStore.getState()).groupByRepoId.get(
      'alias'
    )!.key
    const inputs: SectionRowsArgs = {
      groupBy: 'repo',
      projectOrderBy: 'manual',
      pinnedDisplayPolicy: 'single-location',
      defaultHostId: 'local',
      worktrees: [],
      repos,
      repoMap,
      worktreeMap,
      worktreeLineageById: {},
      prCache: null,
      settings,
      workspaceStatuses,
      effectiveCollapsedGroups: new Set(),
      projectGrouping,
      visibleReposForRows: repos,
      visibleProjectGroupsForRows: [rootGroup, childGroup, otherGroup],
      visibleFolderWorkspacesForRows: [],
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      filterRepoIds: [],
      visibleWorkspaceHostIds: ['local', 'runtime:builder'],
      workspaceHostScope: 'all'
    }
    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null)
      const collapsedGroups = useAppStore((state) => state.collapsedGroups)
      const pending = useAppStore((state) => state.pendingRevealSidebarRow)
      const model = useSidebarSectionRows({ ...inputs, effectiveCollapsedGroups: collapsedGroups })
      useSidebarRevealRequests({
        groupBy: 'repo',
        renderedSidebarRowKeys: model.renderedSidebarRowKeys,
        visibleWorktrees: [],
        visibleFolderWorkspaces: [],
        currentSidebarWorktreeId: null,
        currentSidebarExecutionHostId: null,
        worktreeMap,
        worktrees: [],
        folderWorkspaces: [],
        hasFilters: false,
        revealWorkspaceFilters: () => {}
      })
      usePendingSidebarReveal({
        occurrencePlan: model.occurrencePlan,
        headerRevealPlacements: model.headerRevealPlacements,
        pendingRevealWorktree: null,
        pendingRevealSidebarRow: pending,
        clearPendingRevealWorktreeId: () => {},
        clearPendingRevealSidebarRow: useAppStore.getState().clearPendingRevealSidebarRow,
        agentSendTargetWorktreeId: null,
        renderRows: model.sectionRows,
        virtualizer,
        scrollRef,
        worktrees: [],
        folderWorkspaces: [],
        repoMap,
        worktreeMap,
        worktreeLineageById: {},
        collapsedGroups,
        toggleGroup: toggle,
        groupBy: 'repo',
        pinnedDisplayPolicy: 'single-location',
        defaultHostId: 'local',
        prCache: null,
        workspaceStatuses,
        settings,
        projectGroups: inputs.visibleProjectGroupsForRows,
        projectGrouping,
        flashRevealedRow: flash,
        markRevealScroll: () => {},
        schedulePendingRevealFrame: schedule,
        cancelPendingRevealFrames: cancel
      })
      return (
        <div ref={scrollRef}>
          {model.sectionRows.map((row) =>
            row.type === 'header' ? (
              <div key={row.key} id={getWorktreeOptionId(row.key)}>
                {row.label}
              </div>
            ) : null
          )}
        </div>
      )
    }
    try {
      render(
        <ConfirmationDialogContext.Provider value={confirmReveal}>
          <Harness />
        </ConfirmationDialogContext.Provider>
      )
      const planned = planCalls.mock.calls.length
      expect(document.getElementById(getWorktreeOptionId(target))).toBeNull()
      act(() => {
        if (entrance === 'custom-row') {
          window.dispatchEvent(
            new CustomEvent(SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT, {
              detail: { target: { type: 'sidebar-row', rowKey: target } }
            })
          )
        } else {
          useAppStore.getState().revealSidebarRow(target, { behavior: 'smooth', highlight: true })
        }
      })
      act(() => {
        for (const callback of frames.splice(0)) {
          callback(0)
        }
      })
      expect(document.getElementById(getWorktreeOptionId(target))).not.toBeNull()
      expect(useAppStore.getState().pendingRevealSidebarRow).toBeNull()
      expect(flash).toHaveBeenCalledWith(target)
      expect(useAppStore.getState().collapsedGroups).toEqual(
        new Set(['project-group:other', 'host:runtime:builder'])
      )
      expect(planCalls).toHaveBeenCalledTimes(planned)
    } finally {
      cleanup()
      planCalls.mockRestore()
      useAppStore.setState(previous, true)
    }
  }
)

it.each([100, 1000])(
  'records placement once for %i headers and reuses it across collapse/reveal and unrelated writes',
  (count) => {
    let reads = 0
    const repos = Array.from({ length: count }, (_, i) => ({
      ...makeRepo(),
      get id() {
        reads++
        return `repo-${i}`
      },
      path: `/repo-${i}`
    }))
    const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
    const project = projectHostSetupProjectionFromRepos(repos)
    const projectGrouping = { projects: project.projects, projectHostSetups: project.setups }
    const inputs: SectionRowsArgs = {
      groupBy: 'repo',
      projectOrderBy: 'manual',
      pinnedDisplayPolicy: 'single-location',
      defaultHostId: 'local',
      worktrees: [],
      repos,
      repoMap,
      worktreeMap: new Map(),
      worktreeLineageById: {},
      prCache: null,
      settings,
      workspaceStatuses,
      effectiveCollapsedGroups: new Set(),
      projectGrouping,
      visibleReposForRows: repos,
      visibleProjectGroupsForRows: [],
      visibleFolderWorkspacesForRows: [],
      importedWorktreesByRepo: new Map(),
      newExternalWorktreesInboxByRepo: new Map(),
      filterRepoIds: [],
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all'
    }
    const planned = vi.spyOn(plans, 'planSidebarRows')
    let renders = 0
    reads = 0
    const hook = renderHook(
      ({ collapsed }) => {
        renders++
        return useSidebarSectionRows({ ...inputs, effectiveCollapsedGroups: collapsed })
      },
      { initialProps: { collapsed: new Set<string>() } }
    )
    const placements = hook.result.current.headerRevealPlacements
    expect(placements.size).toBe(count)
    expect(reads).toBeLessThan(100 * count)
    expect(planned).toHaveBeenCalledTimes(1)
    reads = 0
    const settled = renders
    act(() => useAppStore.setState({ activeRepoId: 'unrelated' }))
    expect(renders).toBe(settled)
    expect(reads).toBe(0)
    hook.rerender({ collapsed: new Set(placements.keys()) })
    expect(hook.result.current.headerRevealPlacements).toBe(placements)
    expect(planned).toHaveBeenCalledTimes(1)
    expect(reads).toBeLessThan(10 * count)
    hook.rerender({ collapsed: new Set() })
    expect(hook.result.current.headerRevealPlacements).toBe(placements)
    expect(planned).toHaveBeenCalledTimes(1)
    hook.unmount()
    planned.mockRestore()
  }
)
