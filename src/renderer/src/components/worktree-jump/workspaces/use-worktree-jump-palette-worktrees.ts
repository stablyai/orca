import { useMemo } from 'react'
import { useWorktreeJumpPaletteRowFilters } from './use-worktree-jump-palette-row-filters'
import { sortWorktreesSmart } from '../../../../../shared/sidebar-list/sorting/smart-sort'
import { buildWorktreeChecksReviewIndex } from '@/components/cmd-j/worktree-checks-review-index'
import { orderEmptyQueryWorktrees } from '@/lib/workspace/search/palette/order-empty-query-worktrees'
import {
  getWorktreePaletteSearchScope,
  isPaletteSearchableWorktree,
  searchWorktreeDocuments
} from '@/lib/workspace/search/worktrees/worktree-palette-search'
import {
  buildPaletteWorktreeIndex,
  resolvePaletteWorktree
} from '@/lib/workspace/search/palette-repo-resolution'
import { indexHiddenProjects } from '../../../../../shared/project/catalog/hidden-projects'
import type { Worktree } from '../../../../../shared/worktree/types'
import { EMPTY_SORTED_WORKTREES } from '../worktree-jump-palette-model'
import { buildWorktreeJumpPaletteDocumentIndex } from '../tabs/worktree-jump-palette-document-index'
import {
  buildWorktreeJumpPaletteWorktreeMaps,
  createPaletteWorktreeArrayReuse
} from './worktree-jump-palette-worktree-maps'
import type { WorktreeJumpPaletteWorktreesInput } from './worktree-jump-palette-worktrees-input'

export function useWorktreeJumpPaletteWorktrees({
  paletteSearchQuery,
  paletteSearchContext,
  repos,
  worktreesByRepo,
  agentStatusByPaneKey,
  tabsByWorktree,
  workspaces,
  filterPredicate,
  hideDefaultBranchWorkspace,
  hideAutomationGeneratedWorkspaces,
  hideCliCreatedWorkspaces,
  hideDetachedHeadWorkspaces,
  hideWorkspacesFromOtherDevices,
  showSleepingWorkspaces,
  alwaysShowDefaultBranchWorkspace,
  ptyIdsByTabId,
  browserTabsByWorktree,
  unifiedTabsByWorktree,
  structuredChatSleptAtByPaneKey,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  runtimeEnvironments,
  runtimeStatusByEnvironmentId,
  lastVisitedAtByWorktreeId,
  paletteStatusInputsActive,
  repoMap,
  runtimePaneTitlesByTabId,
  migrationUnsupportedByPtyId,
  terminalLayoutsByTabId,
  repoByHostIdentity,
  hostOptions,
  hostFilterActive,
  defaultHostId,
  prCache,
  hostedReviewCache,
  settings,
  issueCache,
  workspacePortScan
}: WorktreeJumpPaletteWorktreesInput) {
  const hasQuery = paletteSearchQuery.length > 0
  const isLoading = repos.length > 0 && Object.keys(worktreesByRepo).length === 0
  const hiddenProjects = useMemo(
    () => indexHiddenProjects(repos, defaultHostId),
    [repos, defaultHostId]
  )
  const { emptyQueryVisibleWorktrees, filterHiddenIdentities } = useWorktreeJumpPaletteRowFilters({
    workspaces,
    filterPredicate,
    agentStatusByPaneKey,
    tabsByWorktree,
    hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices,
    showSleepingWorkspaces,
    alwaysShowDefaultBranchWorkspace,
    ptyIdsByTabId,
    browserTabsByWorktree,
    unifiedTabsByWorktree,
    structuredChatSleptAtByPaneKey,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    repoMap,
    defaultHostId,
    hiddenProjects
  })
  const { visibleWorktreesForState, switchableWorktreesForRows } = useMemo(
    () =>
      orderEmptyQueryWorktrees({
        visibleWorktrees: emptyQueryVisibleWorktrees,
        activeWorktreeId,
        activeWorkspaceExecutionHostId,
        lastVisitedAtByWorktreeId
      }),
    [
      emptyQueryVisibleWorktrees,
      activeWorktreeId,
      activeWorkspaceExecutionHostId,
      lastVisitedAtByWorktreeId
    ]
  )
  const searchScopeWorktrees = useMemo(() => {
    const scope = getWorktreePaletteSearchScope({
      hasQuery,
      allWorktrees: workspaces,
      emptyQueryWorktrees: switchableWorktreesForRows,
      hiddenProjects
    })
    return hasQuery && filterPredicate ? scope.filter(filterPredicate.matchesWorktree) : scope
  }, [workspaces, filterPredicate, hasQuery, switchableWorktreesForRows, hiddenProjects])
  const reuseSortedWorktrees = useMemo(() => createPaletteWorktreeArrayReuse(), [])
  const browserSortedWorktrees = useMemo(() => {
    if (!paletteStatusInputsActive) {
      return reuseSortedWorktrees(EMPTY_SORTED_WORKTREES)
    }
    const scope = filterPredicate ? workspaces.filter(filterPredicate.matchesWorktree) : workspaces
    return reuseSortedWorktrees(
      sortWorktreesSmart(
        scope,
        tabsByWorktree,
        repoMap,
        agentStatusByPaneKey,
        runtimePaneTitlesByTabId,
        ptyIdsByTabId,
        migrationUnsupportedByPtyId,
        terminalLayoutsByTabId
      )
    )
  }, [
    reuseSortedWorktrees,
    paletteStatusInputsActive,
    workspaces,
    filterPredicate,
    tabsByWorktree,
    repoMap,
    agentStatusByPaneKey,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    migrationUnsupportedByPtyId,
    terminalLayoutsByTabId
  ])
  const sortedWorktrees = useMemo(
    () =>
      hasQuery
        ? browserSortedWorktrees.filter((worktree) =>
            isPaletteSearchableWorktree(worktree, hiddenProjects)
          )
        : searchScopeWorktrees,
    [hasQuery, browserSortedWorktrees, searchScopeWorktrees, hiddenProjects]
  )
  const paletteWorktreeIndex = useMemo(
    () => buildPaletteWorktreeIndex(browserSortedWorktrees),
    [browserSortedWorktrees]
  )
  const resolveWorktree = useMemo(
    () =>
      (worktreeId: string, hostId: Worktree['hostId'] | undefined): Worktree | undefined =>
        resolvePaletteWorktree(paletteWorktreeIndex, worktreeId, hostId),
    [paletteWorktreeIndex]
  )
  const { worktreeMap, worktreeOrder } = useMemo(
    () => buildWorktreeJumpPaletteWorktreeMaps(browserSortedWorktrees),
    [browserSortedWorktrees]
  )
  const checksReviewByWorktree = useMemo(
    () =>
      buildWorktreeChecksReviewIndex({
        worktrees: workspaces,
        repoByHostIdentity,
        prCache,
        hostedReviewCache,
        settings
      }),
    [workspaces, hostedReviewCache, prCache, repoByHostIdentity, settings]
  )
  const worktreeDocuments = useMemo(
    () =>
      buildWorktreeJumpPaletteDocumentIndex({
        worktrees: workspaces,
        repoMap,
        repoByHostIdentity,
        hostOptions,
        hostFilterActive,
        prCache,
        issueCache,
        workspacePortScan,
        checksReviewByWorktree
      }),
    [
      workspaces,
      checksReviewByWorktree,
      hostFilterActive,
      hostOptions,
      issueCache,
      prCache,
      repoByHostIdentity,
      repoMap,
      workspacePortScan
    ]
  )
  const worktreeMatches = useMemo(
    () =>
      searchWorktreeDocuments({
        worktrees: sortedWorktrees,
        query: paletteSearchQuery,
        documents: worktreeDocuments,
        repoMap,
        repoMapByHostIdentity: repoByHostIdentity,
        checksReviewByWorktree,
        context: paletteSearchContext,
        lastVisitedAtByWorktreeId
      }),
    [
      checksReviewByWorktree,
      lastVisitedAtByWorktreeId,
      paletteSearchQuery,
      paletteSearchContext,
      repoByHostIdentity,
      repoMap,
      sortedWorktrees,
      worktreeDocuments
    ]
  )
  return {
    hasQuery,
    isLoading,
    visibleWorktreesForState,
    switchableWorktreesForRows,
    searchScopeWorktrees,
    browserSortedWorktrees,
    worktreeMap,
    resolveWorktree,
    paletteWorktreeIndex,
    worktreeOrder,
    worktreeMatches,
    filterHiddenIdentities
  }
}

export type WorktreeJumpPaletteWorktrees = ReturnType<typeof useWorktreeJumpPaletteWorktrees>
