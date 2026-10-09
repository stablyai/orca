import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
export type { SidebarFilterState } from './visible-worktree-kinds'
export {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptionNarrowingList,
  isSleepingSweepExemptWorkspace
} from './visible-worktree-kinds'
export { sidebarHasActiveFilters, computeClearFilterActions } from './sidebar-filter-actions'
export type { ClearFilterActions } from './sidebar-filter-actions'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace,
  isSleepingSweepExemptWorkspace
} from './visible-worktree-kinds'
import type { Worktree } from '../../../../shared/worktree/types'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
export {
  EMPTY_STRUCTURED_CHAT_WORKTREE_IDS,
  getWorktreeIdsWithStructuredChat
} from './visible-worktree-activity-inputs'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getWorktreeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'
import { isWorkspaceFromOtherDevice } from './workspace-creator-visibility'
import { isDefaultBranchWorkspace } from './default-branch-workspace'
import { getLineageAncestorIndex, getSortedWorktreeRankIndex } from './visible-worktree-indexes'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/**
 * Whether the "Hide sleeping" sweep must keep this row (#8873).
 *
 * Why isMainWorktree and not isDefaultBranchWorkspace: the project's primary
 * checkout is the repo's only guaranteed entry point. Detached-HEAD and offline
 * SSH mains fail the default-branch predicate yet often have no sibling row at
 * all, so sweeping them drops the entire project out of the sidebar, Cmd+J and
 * the board with no way back except changing a filter.
 *
 * Why shared: the sidebar pipeline and the jump palette both apply this, and a
 * second copy is how the two surfaces drift.
 */
export type VisibleWorktreeOptions = {
  filterRepoIds: readonly string[]
  showSleepingWorkspaces: boolean
  tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, { id: string }[]> | null
  worktreeIdsWithLiveAgent: ReadonlySet<string>
  worktreeIdsWithStructuredChat?: ReadonlySet<string>
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  alwaysShowDefaultBranchWorkspace?: boolean
  repoMap: Map<string, Repo>
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  worktreeLineageById: Record<string, WorktreeLineage>
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
}

export function computeVisibleWorktrees(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedIds: string[],
  opts: VisibleWorktreeOptions
): Worktree[] {
  let all: Worktree[] = getAllWorktreesFromState({ worktreesByRepo })

  // Filter archived
  all = all.filter((w) => !w.isArchived)

  // Why: sidebar lineage is structural. Archived workspaces stay hidden, but
  // every other valid ancestor can bypass filters so children never orphan.
  const lineageAncestorById = getLineageAncestorIndex(worktreesByRepo)

  if (opts.hideWorkspacesFromOtherDevices) {
    all = all.filter(
      (worktree) => !isWorkspaceFromOtherDevice(worktree, opts.pairedDeviceIdsByEnvironment)
    )
  }

  if (opts.hideDefaultBranchWorkspace) {
    all = all.filter((w) => !isDefaultBranchWorkspace(w, opts.repoMap.get(w.repoId)))
  }

  if (opts.hideAutomationGeneratedWorkspaces) {
    all = all.filter((w) => !isAutomationGeneratedWorkspace(w))
  }

  if (opts.hideCliCreatedWorkspaces) {
    all = all.filter((w) => !isCliCreatedWorkspace(w))
  }

  if (opts.hideDetachedHeadWorkspaces) {
    all = all.filter((w) => !isDetachedHeadWorkspace(w))
  }

  const visibleHostIds =
    opts.visibleWorkspaceHostIds ??
    (opts.workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [opts.workspaceHostScope])
  if (visibleHostIds) {
    const visibleHostIdSet = new Set(visibleHostIds)
    all = all.filter((w) => {
      const repo = opts.repoMap.get(w.repoId)
      if (!repo) {
        return false
      }
      const hostId = getWorktreeExecutionHostId(w, repo, opts.defaultHostId)
      return visibleHostIdSet.has(hostId)
    })
  }

  // Filter by repo
  if (opts.filterRepoIds.length > 0) {
    const selectedRepoIds = new Set(opts.filterRepoIds)
    all = all.filter((w) => selectedRepoIds.has(w.repoId))
  }

  if (!opts.showSleepingWorkspaces) {
    // Why no !hideDefaultBranchWorkspace term: that filter already ran above, so
    // an explicit hide still wins over the exemption.
    all = all.filter(
      (w) =>
        isSleepingSweepExemptWorkspace(w, opts.alwaysShowDefaultBranchWorkspace) ||
        !isInactiveWorkspace(
          w.id,
          opts.tabsByWorktree,
          opts.ptyIdsByTabId,
          opts.browserTabsByWorktree,
          opts.worktreeIdsWithLiveAgent,
          opts.worktreeIdsWithStructuredChat
        )
    )
  }

  if (opts.forcedVisibleWorktreeIds && opts.forcedVisibleWorktreeIds.length > 0) {
    const includedIds = new Set(all.map((worktree) => worktree.id))
    for (const worktreeId of opts.forcedVisibleWorktreeIds) {
      const worktree = lineageAncestorById.get(worktreeId)
      if (worktree && !includedIds.has(worktreeId)) {
        includedIds.add(worktreeId)
        all.push(worktree)
      }
    }
  }

  // Apply cached sort order. Items not yet in the cache (e.g. brand-new
  // worktrees before the next sortEpoch bump) are appended at the end.
  // Manual placement belongs to the parent, even when a hidden child has a higher rank.
  if (opts.injectLineageAncestors !== false && opts.preserveLineageParentOrder) {
    all = addVisibleLineageAncestors(all, lineageAncestorById, opts.worktreeLineageById)
  }
  const orderIndex = getSortedWorktreeRankIndex(sortedIds)
  all.sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? Infinity
    const bi = orderIndex.get(b.id) ?? Infinity
    return ai - bi
  })

  return opts.injectLineageAncestors === false || opts.preserveLineageParentOrder
    ? all
    : addVisibleLineageAncestors(all, lineageAncestorById, opts.worktreeLineageById)
}

function addVisibleLineageAncestors(
  worktrees: Worktree[],
  worktreeById: Map<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>
): Worktree[] {
  const result: Worktree[] = []
  const included = new Set<string>()
  const visiting = new Set<string>()
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeById)

  const addWithAncestors = (worktree: Worktree): void => {
    const identity = getWorktreeHostIdentity(worktree)
    if (included.has(identity) || visiting.has(identity)) {
      return
    }
    visiting.add(identity)
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeById, cyclicLineageIds)
    if (lineage.state === 'valid') {
      // Why: sidebar lineage is structural. If a filtered child is visible,
      // its valid parent must be rendered too so the hierarchy remains legible.
      addWithAncestors(lineage.parent)
    }
    visiting.delete(identity)
    if (!included.has(identity)) {
      included.add(identity)
      result.push(worktree)
    }
  }

  for (const worktree of worktrees) {
    addWithAncestors(worktree)
  }
  return result
}

export function computeVisibleWorktreeIds(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedIds: string[],
  opts: VisibleWorktreeOptions
): string[] {
  return computeVisibleWorktrees(worktreesByRepo, sortedIds, opts).map((worktree) => worktree.id)
}

export {
  setVisibleWorktreeIds,
  setVisibleWorktreeShortcutTargets,
  getPublishedVisibleWorktreeShortcutTargets,
  getVisibleWorktreeIds,
  getVisibleWorktreeShortcutTargets
} from './visible-worktree-shortcut-targets'
export type { VisibleWorktreeShortcutTarget } from './visible-worktree-shortcut-targets'
