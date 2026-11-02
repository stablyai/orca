/** The sidebar row model golden suite; each build switch runs it into its own directory. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  getRepoMapFromState,
  useProjectHostSetupProjection,
  useRepoMap,
  useWorktreeMap
} from '@/store/selectors'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host'
import { getPinnedWorktreeDisplayPolicy } from '../../../../shared/sidebar-list/row-types'
import { selectWorktreeListReviewCacheInputs } from './worktree-list/listing/review-cache-inputs'
import { useAgentSendTargetWorktreeId } from './worktree-list/listing/use-agent-send-target'
import { useSidebarExternalWorktreeCards } from './worktree-list/listing/use-external-worktree-cards'
import { useSidebarHostVisibleScope } from './worktree-list/listing/use-host-visible-scope'
import { useSidebarSectionRows } from './worktree-list/listing/use-section-rows'
import { useSidebarWorktreeFilters } from './worktree-list/listing/use-filters'
import { useSidebarWorktreeSelection } from './worktree-list/navigation/use-selection'
import { useSidebarWorktreeSortOrder } from './worktree-list/listing/use-sort-order'
import { useVisibleSidebarWorktrees } from './worktree-list/listing/use-visible-worktrees'
import { EMPTY_PROJECT_GROUPS } from './worktree-list/viewport/viewport-props'
import {
  getPublishedVisibleWorktreeShortcutTargets,
  getVisibleWorktreeIds,
  getVisibleWorktreeShortcutTargets
} from './visible-worktrees'
import { computeVisibleWorktreeIds } from './compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import { GOLDEN_NOW } from './sidebar-list-golden-factories.test-fixture'
import {
  GOLDEN_WORKTREE_IDS,
  buildGoldenStoreState,
  goldenInboxState,
  goldenLiveTerminalState,
  type GoldenView
} from './sidebar-list-golden-store.test-fixture'
import { goldenNameOrderState } from './sidebar-list-golden-name-order.test-fixture'
import {
  serializeOccurrencePlan,
  serializeShortcutTargets,
  serializeSidebarRow
} from './sidebar-list-golden-serialize.test-fixture'

export const initialState = useAppStore.getInitialState()

/** The WorktreeList row pipeline, hook for hook, without the virtualized viewport. */
function useGoldenSidebarPipeline() {
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const groupBy = useAppStore((s) => s.groupBy)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const sortBy = useAppStore((s) => s.sortBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const projectGroups = useAppStore((s) => s.projectGroups ?? EMPTY_PROJECT_GROUPS)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const settings = useAppStore((s) => s.settings)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const { prCache } = useAppStore(
    useShallow((s) => selectWorktreeListReviewCacheInputs(s, groupBy, cardProps))
  )
  const pinnedDisplayPolicy = getPinnedWorktreeDisplayPolicy(settings)
  const defaultHostId = getSettingsFocusedExecutionHostId(settings)
  const projection = useProjectHostSetupProjection()
  const projectGrouping = useMemo(
    () => ({ projects: projection.projects, projectHostSetups: projection.setups }),
    [projection]
  )
  const agentSendTargetWorktreeId = useAgentSendTargetWorktreeId()
  const { filterState } = useSidebarWorktreeFilters()
  const sortedIds = useSidebarWorktreeSortOrder({ repoMap, sortBy })
  const { visibleWorktrees, pairedDeviceIdsByEnvironment } = useVisibleSidebarWorktrees({
    filterState,
    sortBy,
    sortedIds,
    repoMap,
    worktreeLineageById,
    defaultHostId,
    agentSendTargetWorktreeId
  })
  const visibleScope = useSidebarHostVisibleScope({
    filterState,
    defaultHostId,
    repos,
    projectGroups,
    folderWorkspaces,
    pairedDeviceIdsByEnvironment
  })
  const externalWorktreeCards = useSidebarExternalWorktreeCards({
    repos,
    visibleReposForRows: visibleScope.visibleReposForRows,
    detectedWorktreesByRepo,
    filterRepoIds: filterState.filterRepoIds
  })
  const rowModel = useSidebarSectionRows({
    groupBy,
    projectOrderBy,
    pinnedDisplayPolicy,
    defaultHostId,
    worktrees: visibleWorktrees,
    repos,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    prCache,
    settings,
    workspaceStatuses,
    effectiveCollapsedGroups: collapsedGroups,
    agentSendTargetWorktreeId,
    projectGrouping,
    visibleReposForRows: visibleScope.visibleReposForRows,
    visibleProjectGroupsForRows: visibleScope.visibleProjectGroupsForRows,
    visibleFolderWorkspacesForRows: visibleScope.visibleFolderWorkspacesForRows,
    importedWorktreesByRepo: externalWorktreeCards.importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo: externalWorktreeCards.newExternalWorktreesInboxByRepo,
    filterRepoIds: filterState.filterRepoIds,
    visibleWorkspaceHostIds: filterState.visibleWorkspaceHostIds,
    workspaceHostScope: filterState.workspaceHostScope
  })
  const selection = useSidebarWorktreeSelection({
    sectionRows: rowModel.sectionRows,
    pinnedDisplayPolicy
  })
  return { visibleWorktrees, rowModel, selection }
}

function captureGolden(state: Partial<AppState>): string {
  useAppStore.setState(state)
  const { result, unmount } = renderHook(() => useGoldenSidebarPipeline())
  const { visibleWorktrees, rowModel, selection } = result.current
  const statuses = useAppStore.getState().workspaceStatuses
  const lines = [
    `visible: ${visibleWorktrees.map((worktree) => worktree.id).join(' ') || '-'}`,
    ...rowModel.sectionRows.map((row) => serializeSidebarRow(row, statuses))
  ]
  if (rowModel.sectionRows.length !== rowModel.rows.length) {
    lines.push(
      '-- rows before host sections --',
      ...rowModel.rows.map((row) => serializeSidebarRow(row, statuses))
    )
  }
  lines.push(
    ...serializeOccurrencePlan(
      rowModel.occurrencePlan,
      new Set(rowModel.sectionRows.flatMap((row) => (row.type === 'item' ? [row.rowKey] : [])))
    ),
    `renderedKeys: ${rowModel.renderedSidebarRowKeys.size}`,
    `placeholders: ${[...rowModel.placeholderRepoIds].join(' ') || '-'}`,
    `selectionOrder: ${selection.renderedWorktreeIdentities.join(' ') || '-'}`,
    `cmd1-9 mounted: ${serializeShortcutTargets(getPublishedVisibleWorktreeShortcutTargets())}`
  )
  unmount()
  lines.push(
    `cmd1-9 unmounted: ${serializeShortcutTargets(getVisibleWorktreeShortcutTargets())}`,
    `cmd ids unmounted: ${getVisibleWorktreeIds().join(' ') || '-'}`
  )
  return lines.join('\n')
}

/** Collapses every other header and the first lineage parent, as read from the expanded output. */
function collapsedKeysFrom(expanded: string): Set<string> {
  const keys: string[] = []
  let lineageKey: string | null = null
  for (const row of expanded.split('\n')) {
    const header = /^(?:HEADER|HOST) key=(\S+)(?: collapseKey=(\S+))?/.exec(row)
    if (header) {
      keys.push(header[2] ?? header[1])
    }
    const lineage = / lineageKey=(\S+)/.exec(row)
    if (!lineageKey && lineage) {
      lineageKey = lineage[1]
    }
  }
  const collapsed = new Set(keys.filter((_, index) => index % 2 === 0))
  if (lineageKey) {
    collapsed.add(lineageKey)
  }
  return collapsed
}

export const GROUP_BYS: AppState['groupBy'][] = ['none', 'repo', 'workspace-status', 'pr-status']
const SORT_BYS: AppState['sortBy'][] = ['manual', 'name', 'recent', 'smart', 'repo']
const PROJECT_ORDER_BYS: AppState['projectOrderBy'][] = ['manual', 'recent']

/** Appends one labelled capture, or a pointer to the earlier identical one. */
export function appendCapture(
  sections: string[],
  seen: Map<string, string>,
  label: string,
  output: string
) {
  const earlier = seen.get(output)
  if (earlier) {
    sections.push(`=== ${label} === same as ${earlier}`)
    return
  }
  seen.set(output, label)
  sections.push(`=== ${label} ===`, output)
}

function viewLabel(view: GoldenView): string {
  return `sort=${view.sortBy} projectOrder=${view.projectOrderBy} pinnedInGroups=${view.pinnedInGroups}`
}

export function captureScenario(view: GoldenView, overrides: Partial<AppState> = {}): string {
  const expanded = captureGolden(buildGoldenStoreState(view, overrides))
  useAppStore.setState(initialState, true)
  const collapsed = collapsedKeysFrom(expanded)
  const collapsedOutput = captureGolden(
    buildGoldenStoreState({ ...view, collapsedGroups: collapsed }, overrides)
  )
  return [expanded, `-- collapsed: ${[...collapsed].join(' ') || '-'} --`, collapsedOutput].join(
    '\n'
  )
}

/** The golden suite, writing its files under `goldenDir` (relative to the test file). */
export function defineSidebarListGoldens(goldenDir: string): void {
  describe('sidebar row model goldens', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(GOLDEN_NOW)
      useAppStore.setState(initialState, true)
    })

    afterEach(() => {
      cleanup()
      useAppStore.setState(initialState, true)
      vi.useRealTimers()
    })

    for (const groupBy of GROUP_BYS) {
      it(`groupBy=${groupBy} across sort, project order and pinned policy`, async () => {
        const sections: string[] = []
        const seen = new Map<string, string>()
        for (const sortBy of SORT_BYS) {
          for (const projectOrderBy of PROJECT_ORDER_BYS) {
            for (const pinnedInGroups of [false, true]) {
              const view: GoldenView = {
                groupBy,
                sortBy,
                projectOrderBy,
                pinnedInGroups,
                collapsedGroups: new Set()
              }
              appendCapture(sections, seen, viewLabel(view), captureScenario(view))
              useAppStore.setState(initialState, true)
            }
          }
        }
        await expect(`${sections.join('\n')}\n`).toMatchFileSnapshot(
          `${goldenDir}/group-by-${groupBy}.txt`
        )
      })
    }

    const SCENARIOS: Record<string, Partial<AppState>> = {
      'host-sections': {
        visibleWorkspaceHostIds: ['local', 'ssh:gpu-vm', 'runtime:env-1']
      },
      'single-host-scope': { workspaceHostScope: 'ssh:gpu-vm' },
      'repo-filter': { filterRepoIds: ['orca', 'lab'] },
      'hide-sleeping': { showSleepingWorkspaces: false, ...goldenLiveTerminalState() },
      'hide-default-branch': { hideDefaultBranchWorkspace: true },
      'new-external-inbox': goldenInboxState()
    }

    for (const [name, overrides] of Object.entries(SCENARIOS)) {
      it(`scenario ${name} across groupBy and pinned policy`, async () => {
        const sections: string[] = []
        const seen = new Map<string, string>()
        for (const groupBy of GROUP_BYS) {
          for (const pinnedInGroups of [false, true]) {
            const view: GoldenView = {
              groupBy,
              sortBy: 'manual',
              projectOrderBy: 'manual',
              pinnedInGroups,
              collapsedGroups: new Set()
            }
            appendCapture(
              sections,
              seen,
              `groupBy=${groupBy} pinnedInGroups=${pinnedInGroups}`,
              captureScenario(view, overrides)
            )
            useAppStore.setState(initialState, true)
          }
        }
        await expect(`${sections.join('\n')}\n`).toMatchFileSnapshot(
          `${goldenDir}/scenario-${name}.txt`
        )
      })
    }

    it('orders accented, mixed-case and numbered names across sorts and grouping', async () => {
      const sections: string[] = []
      const seen = new Map<string, string>()
      for (const groupBy of ['none', 'repo'] as const) {
        for (const sortBy of ['name', 'recent', 'repo'] as const) {
          for (const projectOrderBy of PROJECT_ORDER_BYS) {
            const view: GoldenView = {
              groupBy,
              sortBy,
              projectOrderBy,
              pinnedInGroups: false,
              collapsedGroups: new Set()
            }
            appendCapture(
              sections,
              seen,
              `groupBy=${groupBy} sort=${sortBy} projectOrder=${projectOrderBy}`,
              captureGolden(buildGoldenStoreState(view, goldenNameOrderState()))
            )
            useAppStore.setState(initialState, true)
          }
        }
      }
      await expect(`${sections.join('\n')}\n`).toMatchFileSnapshot(
        `${goldenDir}/scenario-name-order.txt`
      )
    })

    it('orders rows missing from the frozen sort order last', async () => {
      const state = buildGoldenStoreState({
        groupBy: 'none',
        sortBy: 'manual',
        projectOrderBy: 'manual',
        pinnedInGroups: false,
        collapsedGroups: new Set()
      })
      useAppStore.setState(state)
      const fullState = useAppStore.getState()
      const repoMap = getRepoMapFromState(fullState)
      const options = buildVisibleWorktreeOptionsFromState(fullState, repoMap)
      const lines = [
        [GOLDEN_WORKTREE_IDS.orcaFeatD, GOLDEN_WORKTREE_IDS.orcaFeatA],
        [GOLDEN_WORKTREE_IDS.orcaFeatA],
        []
      ].map(
        (sortedIds) =>
          `sorted [${sortedIds.join(' ')}] -> ${computeVisibleWorktreeIds(
            fullState.worktreesByRepo,
            sortedIds,
            options
          ).join(' ')}`
      )
      await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
        `${goldenDir}/unranked-rows-last.txt`
      )
    })
  })
}
