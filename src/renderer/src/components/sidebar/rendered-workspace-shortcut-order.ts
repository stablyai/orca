import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import type { AppState } from '@/store/types'
import {
  deriveRunningAgentSendTargets,
  type RunningAgentTargetState
} from '@/lib/running-agent-targets'
import {
  getProjectHostSetupProjectionFromState,
  getRepoMapFromState,
  getWorktreeMapFromState
} from '@/store/selectors'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { addHostSectionRows } from './host-section-rows'
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'
import { buildImportedWorktreesCardCandidates } from './imported-worktrees-card-candidates'
import { buildNewExternalWorktreesInboxCandidates } from './new-external-worktrees-inbox-candidates'
import { orderHostSectionOptions } from './host-section-order'
import { getLogicalRepoOrderRankById } from './project-header-drop'
import { buildSidebarHostOptions } from './sidebar-host-options'
import {
  buildRows,
  getGroupKeysForWorktree,
  getLineageGroupKey,
  getPinnedWorktreeDisplayPolicy,
  PINNED_GROUP_KEY,
  type ProjectGroupingModel,
  type WorktreeGroupBy
} from './worktree-list-groups'
import {
  getFolderWorkspaceExecutionHostIdForRows,
  getProjectGroupExecutionHostIdForRows
} from './worktree-list-host-filtering'
import { getRenderedWorktreesInSidebarOrder } from './worktree-sidebar-row-preference'

export function getEligibleAgentSendTargetWorktreeId(
  mode: AppState['agentSendPopoverTargetMode'],
  state: RunningAgentTargetState
): string | null {
  if (!mode) {
    return null
  }
  const targets = deriveRunningAgentSendTargets(state, mode.worktreeId)
  return targets.some((target) => target.status === 'eligible') ? mode.worktreeId : null
}

export function getAgentSendEffectiveCollapsedGroups(args: {
  targetWorktreeId: string | null
  collapsedGroups: Set<string>
  groupBy: WorktreeGroupBy
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  projectGrouping: ProjectGroupingModel
  worktreeLineageById: Record<string, WorktreeLineage>
}): Set<string> {
  const targetWorktree = args.targetWorktreeId
    ? args.worktreeMap.get(args.targetWorktreeId)
    : undefined
  if (!targetWorktree) {
    return args.collapsedGroups
  }

  const next = new Set(args.collapsedGroups)
  if (targetWorktree.isPinned) {
    next.delete(PINNED_GROUP_KEY)
  } else {
    for (const groupKey of getGroupKeysForWorktree(
      args.groupBy,
      targetWorktree,
      args.repoMap,
      args.prCache,
      args.workspaceStatuses,
      args.settings,
      args.projectGroups,
      args.projectGrouping
    )) {
      next.delete(groupKey)
    }
  }

  const seen = new Set<string>()
  let current: Worktree | undefined = targetWorktree
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const lineage = args.worktreeLineageById[current.id]
    const parent = lineage ? args.worktreeMap.get(lineage.parentWorktreeId) : undefined
    if (
      !lineage ||
      !parent ||
      current.instanceId !== lineage.worktreeInstanceId ||
      parent.instanceId !== lineage.parentWorktreeInstanceId
    ) {
      break
    }
    next.delete(getLineageGroupKey(parent.id))
    current = parent
  }
  return next
}

function getVisibleHostIdSet(state: AppState): Set<ExecutionHostId> | null {
  const ids =
    state.visibleWorkspaceHostIds ??
    (state.workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [state.workspaceHostScope])
  return ids ? new Set(ids) : null
}

function getVisibleProjectGroups(
  state: AppState,
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  defaultHostId: ExecutionHostId
): ProjectGroup[] {
  if (!visibleHostIds) {
    return state.projectGroups
  }
  return state.projectGroups.filter((group) =>
    visibleHostIds.has(getProjectGroupExecutionHostIdForRows(group, defaultHostId))
  )
}

function getVisibleFolderWorkspaces(
  state: AppState,
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  defaultHostId: ExecutionHostId
): FolderWorkspace[] {
  if (!visibleHostIds) {
    return state.folderWorkspaces
  }
  const projectGroupById = new Map(state.projectGroups.map((group) => [group.id, group]))
  return state.folderWorkspaces.filter((folderWorkspace) =>
    visibleHostIds.has(
      getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace,
        projectGroup: projectGroupById.get(folderWorkspace.projectGroupId),
        defaultHostId
      })
    )
  )
}

function getVisibleRepos(
  state: AppState,
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  defaultHostId: ExecutionHostId
) {
  if (!visibleHostIds) {
    return state.repos
  }
  return state.repos.filter((repo) => {
    const hostId =
      repo.connectionId || repo.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId
    return visibleHostIds.has(hostId)
  })
}

export function getRenderedWorkspaceShortcutIds(
  state: AppState,
  visibleWorktreeIds: readonly string[]
): string[] {
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const visibleHostIds = getVisibleHostIdSet(state)
  const repoMap = getRepoMapFromState(state)
  const worktreeMap = getWorktreeMapFromState(state)
  const agentSendTargetWorktreeId = getEligibleAgentSendTargetWorktreeId(
    state.agentSendPopoverTargetMode,
    state
  )
  const effectiveVisibleWorktreeIds = [...visibleWorktreeIds]
  if (
    agentSendTargetWorktreeId &&
    !effectiveVisibleWorktreeIds.includes(agentSendTargetWorktreeId) &&
    worktreeMap.has(agentSendTargetWorktreeId)
  ) {
    effectiveVisibleWorktreeIds.push(agentSendTargetWorktreeId)
  }
  const visibleWorktrees = effectiveVisibleWorktreeIds
    .map((id) => worktreeMap.get(id))
    .filter((worktree): worktree is Worktree => worktree !== undefined)
  const visibleRepos = getVisibleRepos(state, visibleHostIds, defaultHostId)
  const projection = getProjectHostSetupProjectionFromState(state)
  const projectGrouping: ProjectGroupingModel = {
    projects: projection.projects,
    projectHostSetups: projection.setups
  }
  const effectiveCollapsedGroups = getAgentSendEffectiveCollapsedGroups({
    targetWorktreeId: agentSendTargetWorktreeId,
    collapsedGroups: state.collapsedGroups,
    groupBy: state.groupBy,
    worktreeMap,
    repoMap,
    prCache: state.prCache,
    workspaceStatuses: state.workspaceStatuses,
    settings: state.settings,
    projectGroups: state.projectGroups,
    projectGrouping,
    worktreeLineageById: state.worktreeLineageById
  })
  const hostOptions = orderHostSectionOptions(
    buildSidebarHostOptions({
      repos: state.repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings: state.settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
    }),
    state.workspaceHostOrder
  )
  const rows = buildRows(
    state.groupBy,
    visibleWorktrees,
    repoMap,
    state.prCache,
    effectiveCollapsedGroups,
    getLogicalRepoOrderRankById(state.repos.map((repo) => repo.id)),
    state.workspaceStatuses,
    state.projectOrderBy,
    state.worktreeLineageById,
    worktreeMap,
    true,
    state.settings,
    getVisibleProjectGroups(state, visibleHostIds, defaultHostId),
    getEmptyProjectPlaceholderRepoIds({
      groupBy: state.groupBy,
      repos: visibleRepos,
      worktreesByRepo: state.worktreesByRepo,
      visibleWorktrees,
      filterRepoIds: state.filterRepoIds
    }),
    buildImportedWorktreesCardCandidates({
      repos: visibleRepos,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      filterRepoIds: state.filterRepoIds
    }),
    buildNewExternalWorktreesInboxCandidates({
      repos: visibleRepos,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      filterRepoIds: state.filterRepoIds
    }),
    Object.values(state.pendingWorktreeCreations).map((creation) => ({
      creationId: creation.creationId,
      repoId: creation.request.repoId
    })),
    projectGrouping,
    getVisibleFolderWorkspaces(state, visibleHostIds, defaultHostId),
    new Map(hostOptions.map((host) => [host.id, host.label])),
    defaultHostId,
    getPinnedWorktreeDisplayPolicy(state.settings)
  )
  const sectionRows = addHostSectionRows({
    rows,
    hostOptions,
    workspaceHostScope: state.workspaceHostScope,
    visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
    defaultHostId,
    collapsedHostKeys: effectiveCollapsedGroups,
    preferProjectGrouping: true
  })

  return getRenderedWorktreesInSidebarOrder(
    sectionRows,
    getPinnedWorktreeDisplayPolicy(state.settings)
  ).map((worktree) => worktree.id)
}
