import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import {
  getLocalExecutionHostLabel,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { createSidebarPRGroupReader } from '../grouping/pr-group-key'
import { useEffectiveCollapsedGroups } from './use-collapsed-groups'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PinnedWorktreeDisplayPolicy,
  Row,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
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
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host-registry'
import { buildSidebarHostOptions } from '../../sidebar-host-options'
import { selectPendingWorktreeCreationKeys } from './pending-worktree-creation-keys'

type SectionRowsArgs = {
  agentSendTargetWorktreeId?: string | null
  groupBy: WorktreeGroupBy
  projectOrderBy: ProjectOrderBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  defaultHostId: ExecutionHostId
  worktrees: Worktree[]
  repos: readonly Repo[]
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  prCache: AppState['prCache'] | null
  settings: AppState['settings']
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  effectiveCollapsedGroups: Set<string>
  projectGrouping: ProjectGroupingModel
  visibleReposForRows: readonly Repo[]
  visibleProjectGroupsForRows: readonly ProjectGroup[]
  visibleFolderWorkspacesForRows: readonly FolderWorkspace[]
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  filterRepoIds: readonly string[]
  visibleWorkspaceHostIds: readonly ExecutionHostId[] | null
  workspaceHostScope: AppState['workspaceHostScope']
}

// Builds the full sidebar row model: grouped worktree rows first, then the host-section
// tier wrapped around them.
export function useSidebarSectionRows(args: SectionRowsArgs) {
  const { repos, worktrees, repoMap, defaultHostId } = args
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const wslHostStatuses = useAppStore((s) => s.wslHostStatuses)
  const wslHostServerFilesMissing = useAppStore((s) => s.wslHostServerFiles === 'missing')
  const workspaceHostOrder = useAppStore((s) => s.workspaceHostOrder)
  const setWorkspaceHostOrder = useAppStore((s) => s.setWorkspaceHostOrder)

  // Why: manual header order is bound to state.repos; Recent/Smart derive order from the sorted worktree stream.
  const repoOrder = useMemo(
    () => getLogicalRepoOrderRankById(repos.map((repo) => repo.id)),
    [repos]
  )
  const allRepoIds = useMemo(() => repos.map((r) => r.id), [repos])
  const placeholderRepoIds = useMemo(
    () =>
      getEmptyProjectPlaceholderRepoIds({
        groupBy: args.groupBy,
        repos: args.visibleReposForRows,
        worktreesByRepo,
        visibleWorktrees: worktrees,
        filterRepoIds: args.filterRepoIds
      }),
    [args.filterRepoIds, args.groupBy, args.visibleReposForRows, worktrees, worktreesByRepo]
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
  const hostOptions = useMemo(
    () =>
      buildSidebarHostOptions({
        repos,
        sshTargetLabels,
        sshConnectionStates,
        settings: args.settings,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides,
        wslHostStatuses,
        wslHostsEnabled: args.settings?.experimentalWslHosts === true,
        wslHostServerFilesMissing
      }),
    [
      repos,
      sshTargetLabels,
      sshConnectionStates,
      args.settings,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides,
      wslHostStatuses,
      wslHostServerFilesMissing
    ]
  )
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )

  const hostScopedGroups =
    args.workspaceHostScope !== 'all' || args.visibleWorkspaceHostIds !== null
  const rowPlan = useMemo(
    () =>
      planSidebarRows({
        groupBy: args.groupBy,
        worktrees,
        repoMap,
        prGroupOf: createSidebarPRGroupReader(repoMap, args.prCache),
        repoOrder,
        workspaceStatuses: args.workspaceStatuses,
        projectOrderBy: args.projectOrderBy,
        lineageById: args.worktreeLineageById,
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
      worktrees,
      repoMap,
      args.prCache,
      defaultHostId,
      repoOrder,
      args.workspaceStatuses,
      args.projectOrderBy,
      args.worktreeLineageById,
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
