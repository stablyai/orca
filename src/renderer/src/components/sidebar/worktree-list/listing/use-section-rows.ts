import { selectWslHostsServing } from '../../use-wsl-hosts-enabled'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { shallow } from 'zustand/shallow'
import { persistedUIValuesEqual } from '../../../../../../shared/persisted-ui-equality'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getLocalExecutionHostLabel,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { createHostScopedRepoOf } from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import { createSidebarPRGroupReader } from '../grouping/pr-group-key'
import { useEffectiveCollapsedGroups } from './use-collapsed-groups'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import type { SectionRowsArgs } from './sidebar-list-model'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import { getEmptyProjectPlaceholderRepoIds } from '../../../../../../shared/sidebar-list/empty-project-placeholder-repos'
import {
  deferHostSectionCollapse,
  scopeHostSectionCollapse
} from '../../../../../../shared/sidebar-list/host-section-collapse'
import { addHostSectionRows } from '../../../../../../shared/sidebar-list/host-section-rows'
import { collectRenderedSidebarRowKeys } from './rendered-row-keys'
import {
  mergeDraggedHostSectionOrder,
  orderHostSectionOptions
} from '../../../../../../shared/sidebar-list/host-section-order'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host/execution-host-registry-entry'
import {
  type SidebarHostOption,
  buildSidebarHostOptions,
  sidebarHostSemantics,
  createSidebarHostLabelsSelector
} from '../controls/sidebar-host-options'
import { selectPendingWorktreeCreationKeys } from './pending-worktree-creation-keys'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { selectEphemeralVmHostLifecycles } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'

function createSidebarHostOptionsSelector() {
  let inputs: readonly unknown[] = []
  let result: SidebarHostOption[] = []
  return (
    state: AppState,
    repos: readonly Repo[],
    settings: AppState['settings'],
    hostLabelOverrides: Parameters<typeof buildSidebarHostOptions>[0]['hostLabelOverrides']
  ): SidebarHostOption[] => {
    const nextInputs = [
      repos,
      state.sshTargetLabels,
      state.sshConnectionStates,
      settings,
      state.runtimeStatusByEnvironmentId,
      state.runtimeEnvironments,
      hostLabelOverrides,
      state.wslHostStatuses,
      selectWslHostsServing(state),
      state.wslHostServerFiles === 'missing',
      selectEphemeralVmHostLifecycles(state)
    ]
    if (shallow(inputs, nextInputs)) {
      return result
    }
    inputs = nextInputs
    const next = buildSidebarHostOptions({
      repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides,
      wslHostStatuses: state.wslHostStatuses,
      wslHostsEnabled: selectWslHostsServing(state),
      wslHostServerFilesMissing: state.wslHostServerFiles === 'missing',
      ephemeralVmHosts: selectEphemeralVmHostLifecycles(state)
    })
    if (!persistedUIValuesEqual(result.map(sidebarHostSemantics), next.map(sidebarHostSemantics))) {
      result = next
    }
    return result
  }
}

export function useSidebarSectionRows(args: SectionRowsArgs) {
  const { repos, worktrees, repoMap, defaultHostId } = args
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const lineageParentIdentities = useAppStore(selectSidebarLineageParentIdentities)
  const workspaceHostOrder = useAppStore((s) => s.workspaceHostOrder)
  const setWorkspaceHostOrder = useAppStore((s) => s.setWorkspaceHostOrder)

  // Why: manual header order is bound to state.repos; Recent/Smart derive order from the sorted worktree stream.
  const repoOrder = useMemo(
    () => getLogicalRepoOrderRankById(repos.map((repo) => repo.id)),
    [repos]
  )
  const allRepoIds = useMemo(() => repos.map((r) => r.id), [repos])
  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  const placeholderRepoIds = useMemo(
    () =>
      getEmptyProjectPlaceholderRepoIds({
        groupBy: args.groupBy,
        repos: args.visibleReposForRows,
        worktreesByRepo,
        visibleWorktrees: worktrees,
        filterRepoIds: args.filterRepoIds,
        pendingVmRepoIds: hiddenVmCheckouts.repoIds
      }),
    [
      args.filterRepoIds,
      args.groupBy,
      args.visibleReposForRows,
      worktrees,
      worktreesByRepo,
      hiddenVmCheckouts
    ]
  )

  // Why: subscribe on a flat key array (useShallow) so progress ticks don't rebuild the whole row model.
  const pendingCreationKeys = useAppStore(
    useShallow((s) => selectPendingWorktreeCreationKeys(s.pendingWorktreeCreations))
  )
  const pendingCreations = useMemo(
    () =>
      pendingCreationKeys.map((key) => {
        const separator = key.indexOf(' ')
        return {
          creationId: key.slice(0, separator),
          repoId: key.slice(separator + 1)
        }
      }),
    [pendingCreationKeys]
  )
  const hostLabelOverrides = useMemo(
    () => getHostDisplayLabelOverrides(args.settings),
    [args.settings]
  )
  const selectHostOptions = useMemo(() => createSidebarHostOptionsSelector(), [])
  const selectHostLabels = useMemo(() => createSidebarHostLabelsSelector(), [])
  const hostOptions = useAppStore((state) =>
    selectHostOptions(state, repos, args.settings, hostLabelOverrides)
  )
  const hostLabelById = useMemo(
    () => selectHostLabels(hostOptions),
    [hostOptions, selectHostLabels]
  )

  const hostScopedGroups =
    args.workspaceHostScope !== 'all' || args.visibleWorkspaceHostIds !== null
  // Same-id registrations on two hosts: each row and project header needs its own host's.
  const repoOfWorktree = useMemo(() => createHostScopedRepoOf(repos, repoMap), [repos, repoMap])
  const rowPlan = useMemo(
    () =>
      planSidebarRows({
        groupBy: args.groupBy,
        sortBy: args.sortBy,
        worktrees,
        repoMap,
        repoOfWorktree,
        prGroupOf: createSidebarPRGroupReader(repoMap, args.prCache),
        repoOrder,
        workspaceStatuses: args.workspaceStatuses,
        projectOrderBy: args.projectOrderBy,
        lineageById: args.worktreeLineageById,
        lineageParentIdentities,
        worktreeMap: args.worktreeMap,
        nestLineage: true,
        projectGroups: args.visibleProjectGroupsForRows,
        placeholderRepoIds,
        importedWorktreesByRepo: args.importedWorktreesByRepo,
        newExternalWorktreesInboxByRepo: args.newExternalWorktreesInboxByRepo,
        pendingCreations,
        projectGrouping: args.projectGrouping,
        folderWorkspaces: args.visibleFolderWorkspacesForRows,
        hostLabelById,
        defaultHostId,
        pinnedDisplayPolicy: args.pinnedDisplayPolicy,
        filterRepoIds: args.filterRepoIds
      }),
    [
      args.groupBy,
      args.sortBy,
      worktrees,
      repoMap,
      repoOfWorktree,
      args.prCache,
      defaultHostId,
      repoOrder,
      args.workspaceStatuses,
      args.projectOrderBy,
      args.worktreeLineageById,
      lineageParentIdentities,
      args.worktreeMap,
      args.projectGrouping,
      args.visibleProjectGroupsForRows,
      args.visibleFolderWorkspacesForRows,
      placeholderRepoIds,
      args.importedWorktreesByRepo,
      args.newExternalWorktreesInboxByRepo,
      pendingCreations,
      hostLabelById,
      args.pinnedDisplayPolicy,
      args.filterRepoIds
    ]
  )
  const effectiveCollapsedGroups = useEffectiveCollapsedGroups({
    occurrencePlan: rowPlan.occurrencePlan,
    hostScopedGroups,
    collapsedGroups: args.effectiveCollapsedGroups,
    agentSendTargetWorktreeId: args.agentSendTargetWorktreeId ?? null,
    groupBy: args.groupBy,
    pinnedDisplayPolicy: args.pinnedDisplayPolicy,
    worktrees,
    visibleWorktrees: worktrees,
    filterRepoIds: args.filterRepoIds,
    repoMap,
    worktreeMap: args.worktreeMap,
    worktreeLineageById: args.worktreeLineageById,
    prCache: args.prCache,
    workspaceStatuses: args.workspaceStatuses,
    projectGroups: args.visibleProjectGroupsForRows,
    projectGrouping: args.projectGrouping,
    folderWorkspaces: args.visibleFolderWorkspacesForRows,
    defaultHostId
  })
  const rowCollapsedGroups = useMemo(
    () =>
      hostScopedGroups
        ? deferHostSectionCollapse(effectiveCollapsedGroups)
        : effectiveCollapsedGroups,
    [effectiveCollapsedGroups, hostScopedGroups]
  )
  const rows: Row[] = useMemo(
    () => rowPlan.render(rowCollapsedGroups),
    [rowPlan, rowCollapsedGroups]
  )
  const orderedHostOptions = useMemo(
    () => orderHostSectionOptions(hostOptions, workspaceHostOrder),
    [hostOptions, workspaceHostOrder]
  )
  const [hostDragActive, setHostDragActive] = useState(false)
  const handleReorderHostSections = useCallback(
    (orderedVisibleHostIds: ExecutionHostId[]) =>
      setWorkspaceHostOrder(
        mergeDraggedHostSectionOrder(
          orderedVisibleHostIds,
          workspaceHostOrder,
          orderedHostOptions.map((host) => host.id)
        )
      ),
    [orderedHostOptions, setWorkspaceHostOrder, workspaceHostOrder]
  )
  const sectionRows = useMemo(() => {
    const sectioned = addHostSectionRows({
      rows,
      hostOptions: orderedHostOptions,
      workspaceHostScope: args.workspaceHostScope,
      visibleWorkspaceHostIds: args.visibleWorkspaceHostIds,
      defaultHostId,
      localHostLabel: getLocalExecutionHostLabel(),
      collapsedHostKeys: effectiveCollapsedGroups,
      forceCollapseHosts: hostDragActive,
      // Why: projects/workspaces are the primary sidebar object; host sections are only an explicit host-filter view.
      preferProjectGrouping: true
    })
    return hostScopedGroups
      ? scopeHostSectionCollapse({
          rows: sectioned,
          collapsedGroups: effectiveCollapsedGroups
        })
      : sectioned
  }, [
    args.visibleWorkspaceHostIds,
    args.workspaceHostScope,
    defaultHostId,
    effectiveCollapsedGroups,
    hostDragActive,
    hostScopedGroups,
    orderedHostOptions,
    rows
  ])
  const renderedSidebarRowKeys = useMemo(
    () => collectRenderedSidebarRowKeys(sectionRows),
    [sectionRows]
  )

  const headerHostOptions: readonly ExecutionHostRegistryEntry[] = hostOptions
  return {
    occurrencePlan: rowPlan.occurrencePlan,
    hostOptions: headerHostOptions,
    effectiveCollapsedGroups,
    rows,
    sectionRows,
    renderedSidebarRowKeys,
    allRepoIds,
    placeholderRepoIds,
    handleReorderHostSections,
    setHostDragActive
  }
}
