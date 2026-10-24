import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getWorktreeExecutionHostId,
  normalizeExecutionHostOrder,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../execution-host'
import type { ProjectGroup } from '../project-group-types'
import { getLogicalRepoOrderRankById } from '../project-section-order'
import type { ProjectSectionModel } from '../project-section-grouping'
import type { Repo } from '../repo-types'
import type { ProjectOrderBy } from '../ui-chrome-types'
import {
  filterFolderWorkspacesFromOtherDevices,
  isWorkspaceOwnedBySomeoneElse
} from '../workspace-creator-visibility'
import type { WorkspaceRowFilters } from '../workspace-view/workspace-row-filters'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { collectActiveRowKeys } from './active-workspace'
import {
  buildFeedHostOptions,
  indexSidebarFeed,
  rankSidebarFeedWorktrees,
  type SidebarFeedIndex
} from './sidebar-feed-index'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { FolderWorkspace } from '../folder-workspace-types'
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  filterReposForVisibleHosts,
  getVisibleSidebarHostIdSet
} from './host-filtering'
import { deferHostSectionCollapse, scopeHostSectionCollapse } from './host-section-collapse'
import { orderHostSectionOptions } from './host-section-order'
import {
  addHostSectionRows,
  type HostSectionOption,
  type HostSectionRow
} from './host-section-rows'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PinnedWorktreeDisplayPolicy,
  Row,
  WorktreeGroupBy
} from './row-types'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import { planSidebarRows } from './sidebar-row-plan'
import type { SortBy } from './smart-sort'
import { selectVisibleSidebarWorktrees } from './visible-worktrees'
import { isIdleWorkspaceActivity } from './workspace-activity-facts'
import { prGroupOfReviewFact } from './workspace-review-facts'

/** The host's view settings a reader shows the list with; the host's own phone reads them off ui.get. */
export type SidebarFeedView = {
  groupBy: WorktreeGroupBy
  sortBy: SortBy
  projectOrderBy: ProjectOrderBy
  collapsedGroups: ReadonlySet<string>
  filters: WorkspaceRowFilters
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds: readonly ExecutionHostId[] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  /** The host the desktop has focused (its settings' active runtime), where unowned rows land. */
  defaultHostId: ExecutionHostId
  hostLabelOverrides: ReadonlyMap<ExecutionHostId, string>
  /** The listed host's name for itself when the user has not renamed it. */
  localHostLabel: string
  /** The desktop window's own saved host order, which it writes; a phone reads the host's. */
  workspaceHostOrder?: readonly ExecutionHostId[]
}

/** The catalog the feed does not carry: every host's repos (repo.list), groups and projects. */
export type SidebarFeedCatalog = {
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  projectGrouping: ProjectSectionModel
}

export type SidebarFeedRows = {
  visibleWorktrees: Worktree[]
  rows: Row[]
  sectionRows: HostSectionRow[]
  /** Row keys of every occurrence of the desktop's open workspace; a pinned duplicate shows twice. */
  activeRowKeys: ReadonlySet<string>
}

/** What only the desktop window adds over the inputs: transient reveals and its own cards. */
export type SidebarFeedWindowExtras = {
  forcedVisibleWorktreeIds?: readonly string[]
  importedWorktreesByRepo?: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo?: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
}

export type SidebarFeedPlan = {
  visibleWorktrees: Worktree[]
  plan: ReturnType<typeof planSidebarRows>
  worktreeMap: Map<string, Worktree>
  lineageById: Record<string, WorktreeLineage>
  placeholderRepoIds: Set<string>
  visibleProjectGroups: readonly ProjectGroup[]
  visibleFolderWorkspaces: readonly FolderWorkspace[]
  orderedHostOptions: HostSectionOption[]
  hostScoped: boolean
}

const NO_LINEAGE_MAP: Record<string, WorktreeLineage> = {}

/** Filters, groups and nests the feed's workspaces in `rankedIdentities` order; collapse comes after. */
export function planSidebarFeedRows(
  domains: SidebarFeedDomains,
  index: SidebarFeedIndex,
  catalog: SidebarFeedCatalog,
  view: SidebarFeedView,
  rankedIdentities: readonly string[],
  extras: SidebarFeedWindowExtras = {}
): SidebarFeedPlan {
  const { repos, projectGroups } = catalog
  const { defaultHostId, groupBy } = view
  const { workspaces, worktrees: allWorktrees, folderWorkspaces, repoMap } = index
  const byIdentity = new Map(workspaces.map((entry) => [entry.identity, entry]))
  const worktreeMap = new Map<string, Worktree>()
  const ancestorByIdentity = new Map<string, Worktree>()
  const worktreesByRepo: Record<string, Worktree[]> = {}
  for (const worktree of allWorktrees) {
    if (!worktreeMap.has(worktree.id)) {
      worktreeMap.set(worktree.id, worktree)
    }
    if (!worktree.isArchived) {
      ancestorByIdentity.set(getWorktreeHostIdentity(worktree), worktree)
    }
    const repoWorktrees = worktreesByRepo[worktree.repoId]
    if (repoWorktrees) {
      repoWorktrees.push(worktree)
    } else {
      worktreesByRepo[worktree.repoId] = [worktree]
    }
  }
  // Each row carries its own edge (sidebar-feed-worktrees.ts); an id-keyed map would keep one host's.
  const lineageById = NO_LINEAGE_MAP
  const retained = new Set(domains.retention?.retainedIds)
  const rankByIdentity = new Map(rankedIdentities.map((identity, rank) => [identity, rank]))
  const factsOf = (worktree: Worktree) => byIdentity.get(getWorktreeHostIdentity(worktree))?.facts
  const pairedDeviceIdsByEnvironment = new Map(
    [...domains.pairedServerHosts].flatMap(([hostId, { host }]) => {
      const environmentId = parseExecutionHostId(hostId)
      return environmentId?.kind === 'runtime' && host?.pairedDeviceId
        ? [[environmentId.environmentId, host.pairedDeviceId] as const]
        : []
    })
  )

  const visibleWorktrees = selectVisibleSidebarWorktrees({
    rows: allWorktrees,
    ancestorByIdentity,
    rankOf: (worktree) => rankByIdentity.get(getWorktreeHostIdentity(worktree)),
    filters: view.filters,
    facts: {
      isArchived: (worktree) => worktree.isArchived,
      isFolderWorkspace: () => false,
      repoId: (worktree) => worktree.repoId,
      hostId: (worktree) => {
        const repo = index.repoOf(worktree)
        return repo ? getWorktreeExecutionHostId(worktree, repo, defaultHostId) : null
      },
      isOtherClient: (worktree) =>
        isWorkspaceOwnedBySomeoneElse(worktree, pairedDeviceIdsByEnvironment),
      isDefaultBranch: (worktree) => factsOf(worktree)?.defaultBranch === true,
      isAutomationCreated: (worktree) => factsOf(worktree)?.automationCreated === true,
      isCliCreated: (worktree) => factsOf(worktree)?.cliCreated === true,
      isDetachedHead: (worktree) => factsOf(worktree)?.detachedHead === true,
      isMainWorktree: (worktree) => worktree.isMainWorktree,
      isSleeping: (worktree) => {
        const identity = getWorktreeHostIdentity(worktree)
        const activity = domains.activity.get(identity)
        return !retained.has(identity) && (!activity || isIdleWorkspaceActivity(activity))
      }
    },
    worktreeLineageById: lineageById,
    filterRepoIds: view.filters.filterRepoIds,
    preserveLineageParentOrder: view.sortBy === 'manual',
    forcedVisibleWorktreeIds: extras.forcedVisibleWorktreeIds
  })

  const visibleHostIdSet = getVisibleSidebarHostIdSet(
    view.visibleWorkspaceHostIds,
    view.workspaceHostScope
  )
  const visibleRepos = filterReposForVisibleHosts(repos, visibleHostIdSet, defaultHostId)
  const hostVisibleFolderWorkspaces = filterFolderWorkspacesForVisibleHosts(
    folderWorkspaces,
    projectGroups,
    visibleHostIdSet,
    defaultHostId
  )
  const visibleFolderWorkspaces = view.filters.hideWorkspacesFromOtherDevices
    ? filterFolderWorkspacesFromOtherDevices(
        hostVisibleFolderWorkspaces,
        pairedDeviceIdsByEnvironment
      )
    : hostVisibleFolderWorkspaces
  const visibleProjectGroups = filterProjectGroupsForVisibleHosts(
    projectGroups,
    visibleHostIdSet,
    defaultHostId
  )
  const listed = new Set(workspaces.map((entry) => entry.worktree.id))
  const pendingCreations = [...domains.creations].flatMap(([creationId, creation]) =>
    creation.worktreeId !== undefined && listed.has(creation.worktreeId)
      ? []
      : [{ creationId, repoId: creation.repoId }]
  )
  const hostOptions = buildFeedHostOptions(domains, repos, view)
  const placeholderRepoIds = getEmptyProjectPlaceholderRepoIds({
    groupBy,
    repos: visibleRepos,
    worktreesByRepo,
    visibleWorktrees,
    filterRepoIds: view.filters.filterRepoIds
  })
  // The catalog's order, not the feed's repoOrder: only it places a paired server's projects.
  const repoOrder = getLogicalRepoOrderRankById(repos.map((repo) => repo.id))
  const plan = planSidebarRows({
    groupBy,
    worktrees: visibleWorktrees,
    repoMap,
    repoOfWorktree: index.repoOf,
    prGroupOf: (worktree) =>
      prGroupOfReviewFact(domains.review.get(getWorktreeHostIdentity(worktree))),
    repoOrder,
    workspaceStatuses: view.workspaceStatuses,
    projectOrderBy: view.projectOrderBy,
    lineageById,
    worktreeMap,
    nestLineage: true,
    projectGroups: visibleProjectGroups,
    placeholderRepoIds,
    importedWorktreesByRepo: extras.importedWorktreesByRepo ?? new Map(),
    newExternalWorktreesInboxByRepo: extras.newExternalWorktreesInboxByRepo ?? new Map(),
    pendingCreations,
    projectGrouping: catalog.projectGrouping,
    folderWorkspaces: visibleFolderWorkspaces,
    hostLabelById: new Map(hostOptions.map((host) => [host.id, host.label])),
    defaultHostId,
    pinnedDisplayPolicy: view.pinnedDisplayPolicy,
    filterRepoIds: view.filters.filterRepoIds
  })
  return {
    visibleWorktrees,
    plan,
    worktreeMap,
    lineageById,
    placeholderRepoIds,
    visibleProjectGroups,
    visibleFolderWorkspaces,
    orderedHostOptions: orderHostSectionOptions(
      hostOptions,
      normalizeExecutionHostOrder(view.workspaceHostOrder ?? domains.desktop?.workspaceHostOrder)
    ),
    hostScoped:
      view.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE || view.visibleWorkspaceHostIds !== null
  }
}

/** The planned rows under `collapsedGroups`, wrapped in host sections. */
export function renderSidebarFeedRows(
  planned: SidebarFeedPlan,
  view: SidebarFeedView,
  collapsedGroups: ReadonlySet<string>,
  forceCollapseHosts = false
): Pick<SidebarFeedRows, 'rows' | 'sectionRows'> {
  const collapsed = new Set(collapsedGroups)
  const rows = planned.plan.render(
    planned.hostScoped ? deferHostSectionCollapse(collapsed) : collapsed
  )
  const sectioned = addHostSectionRows({
    rows,
    hostOptions: planned.orderedHostOptions,
    workspaceHostScope: view.workspaceHostScope,
    visibleWorkspaceHostIds: view.visibleWorkspaceHostIds,
    defaultHostId: view.defaultHostId,
    localHostLabel: view.localHostLabel,
    collapsedHostKeys: collapsed,
    forceCollapseHosts,
    preferProjectGrouping: true
  })
  const sectionRows = planned.hostScoped
    ? scopeHostSectionCollapse({ rows: sectioned, collapsedGroups: collapsed })
    : sectioned
  return { rows, sectionRows }
}

/**
 * The sidebar a feed reader shows: the host's published inputs through the same builder, filters
 * and host sections the desktop window runs, with no clock. The window's transient overlays (drag
 * previews, search, hover hold, agent-send reveal) and its desktop-only cards are not inputs here.
 */
export function buildSidebarFeedRows(
  domains: SidebarFeedDomains,
  catalog: SidebarFeedCatalog,
  view: SidebarFeedView
): SidebarFeedRows {
  const index = indexSidebarFeed(domains, catalog.repos)
  const planned = planSidebarFeedRows(
    domains,
    index,
    catalog,
    view,
    rankSidebarFeedWorktrees(index, view.sortBy)
  )
  const { rows, sectionRows } = renderSidebarFeedRows(planned, view, view.collapsedGroups)
  const active = {
    worktreeId: domains.desktop?.desktopActive.worktreeId ?? null,
    hostId: parseExecutionHostId(domains.desktop?.desktopActive.hostId)?.id ?? null
  }
  return {
    visibleWorktrees: planned.visibleWorktrees,
    rows,
    sectionRows,
    activeRowKeys: collectActiveRowKeys(sectionRows, active)
  }
}
