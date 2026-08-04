import type { Worktree, Repo, TerminalTab, WorktreeLineage } from '../../../../shared/types'
import { buildWorktreeComparator, sortWorktreesSmart } from './smart-sort'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { useAppStore } from '@/store'
import {
  getAllWorktreesFromState,
  getRepoMapFromState,
  getWorktreeMapFromState
} from '@/store/selectors'
import { DEFAULT_SHOW_SLEEPING_WORKSPACES } from '../../../../shared/constants'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import {
  getCyclicProjectedWorktreeLineageIds,
  getLineageRenderInfo
} from './worktree-lineage-projection'
import { computeRenderedSidebarWorktreeOrder } from './rendered-sidebar-worktree-order'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

/**
 * Whether a worktree represents the repo's default-branch row that the
 * "Hide Default Branch Workspace" setting targets. Folder-mode projects are
 * main worktrees with branch === '' and are intentionally preserved.
 *
 * Why a shared helper: this predicate gates visibility in both the sidebar
 * pipeline (computeVisibleWorktreeIds) and the Cmd+J jump palette. Keeping
 * the definition in one place prevents the two surfaces from drifting.
 */
export function isDefaultBranchWorkspace(worktree: Worktree): boolean {
  return worktree.isMainWorktree && worktree.branch.trim() !== ''
}

/**
 * Whether the "Hide sleeping" sweep must keep this row (#8873).
 *
 * Why isMainWorktree and not isDefaultBranchWorkspace: the project's primary
 * checkout is the repo's only guaranteed entry point. Folder workspaces and
 * detached-HEAD mains fail the default-branch predicate yet often have no
 * sibling row at all, so sweeping them drops the entire project out of the
 * sidebar, Cmd+J and the board with no way back except changing a filter.
 *
 * Why shared: the sidebar pipeline and the jump palette both apply this, and a
 * second copy is how the two surfaces drift.
 */
export function isSleepingSweepExemptWorkspace(
  worktree: Worktree,
  alwaysShowDefaultBranchWorkspace: boolean | undefined
): boolean {
  return alwaysShowDefaultBranchWorkspace !== false && worktree.isMainWorktree
}

export function isAutomationGeneratedWorkspace(worktree: Worktree): boolean {
  return worktree.automationProvenance?.kind === 'created-by-automation'
}

export function isCliCreatedWorkspace(worktree: Worktree): boolean {
  return worktree.cliProvenance?.kind === 'created-by-cli'
}

/**
 * Whether a worktree sits on a detached HEAD (a commit, not a branch).
 *
 * Why the head check: folder workspaces and SSH-synthesized rows carry both an
 * empty branch and an empty head, so branch-emptiness alone would sweep them
 * into this filter. Requiring a real head keeps the predicate to genuine
 * detached-HEAD checkouts, matching what DetachedHeadBadge renders on the card.
 */
export function isDetachedHeadWorkspace(worktree: Worktree): boolean {
  return getWorktreeGitIdentityDisplay(worktree)?.kind === 'detached'
}

/** Inputs describing sidebar filter settings that the Clear Filters path owns. */
export type SidebarFilterState = {
  showSleepingWorkspaces: boolean
  filterRepoIds: readonly string[]
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  /** Keeps each project's main workspace out of the "Hide sleeping" sweep; absent means on. */
  alwaysShowDefaultBranchWorkspace?: boolean
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  workspaceHostScope?: ExecutionHostScope
}

/**
 * Whether at least one sidebar filter is active — drives the "Clear Filters"
 * escape hatch in the empty-state message. Kept pure so it can be unit-tested
 * alongside the sorting pipeline.
 *
 * Why include hideDefaultBranchWorkspace here: without it, a user whose only
 * worktree is the default-branch row and who toggles hide-on would see the
 * "No workspaces found" message with no in-sidebar recovery path.
 */
export function sidebarHasActiveFilters(state: SidebarFilterState): boolean {
  return (
    state.showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES ||
    state.filterRepoIds.length > 0 ||
    state.hideDefaultBranchWorkspace ||
    state.hideAutomationGeneratedWorkspaces ||
    state.hideCliCreatedWorkspaces ||
    state.hideDetachedHeadWorkspaces ||
    // Why: turning this off is the only way to narrow the list below the
    // default, so Clear Filters must be able to undo it like any other filter.
    state.alwaysShowDefaultBranchWorkspace === false ||
    state.visibleWorkspaceHostIds != null ||
    (state.workspaceHostScope != null && state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE)
  )
}

/** Describes which mutators the Clear Filters button must invoke, separated
 *  from the mutators themselves so the decision logic is testable. */
export type ClearFilterActions = {
  resetShowSleepingWorkspaces: boolean
  resetFilterRepoIds: boolean
  resetHideDefaultBranchWorkspace: boolean
  resetHideAutomationGeneratedWorkspaces: boolean
  resetHideCliCreatedWorkspaces: boolean
  resetHideDetachedHeadWorkspaces: boolean
  resetAlwaysShowDefaultBranchWorkspace: boolean
  resetVisibleWorkspaceHostIds: boolean
}

/**
 * Determines which sidebar filters the Clear Filters button needs to reset.
 * Returning an explicit action plan (rather than just calling the setters)
 * keeps the pure decision separate from the impure mutations, so tests can
 * verify the logic without mounting the component.
 *
 * Why reset only the ones that are set: keeps Clear Filters from churning
 * UI state (and the debounced ui.set write-back) on every click when the
 * flag was already off.
 */
export function computeClearFilterActions(state: SidebarFilterState): ClearFilterActions {
  return {
    resetShowSleepingWorkspaces: state.showSleepingWorkspaces !== DEFAULT_SHOW_SLEEPING_WORKSPACES,
    resetFilterRepoIds: state.filterRepoIds.length > 0,
    resetHideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    resetHideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    resetHideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    resetHideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    resetAlwaysShowDefaultBranchWorkspace: state.alwaysShowDefaultBranchWorkspace === false,
    resetVisibleWorkspaceHostIds:
      state.visibleWorkspaceHostIds != null ||
      (state.workspaceHostScope != null && state.workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE)
  }
}

/**
 * Shared pure utility that computes the ordered list of visible (non-archived,
 * non-filtered) worktree IDs. Both the App-level Cmd+1–9 handler and
 * WorktreeList's render pipeline consume this function so the numbering and
 * card order can never diverge.
 *
 * Why a shared function: if the filter/sort pipeline lived in two places, a
 * new filter added in one but not the other would silently break the mapping
 * between badge numbers and the Cmd+N shortcut target.
 */
export function computeVisibleWorktreeIds(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedIds: string[],
  opts: {
    filterRepoIds: string[]
    showSleepingWorkspaces: boolean
    tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
    ptyIdsByTabId: Record<string, string[]> | null
    browserTabsByWorktree?: Record<string, { id: string }[]> | null
    // Why required: every filter caller must preserve running agents through
    // temporary PTY gaps instead of silently reverting #7197.
    worktreeIdsWithLiveAgent: ReadonlySet<string>
    // Why required: every caller (WorktreeList, getVisibleWorktreeIds
    // fallback, tests) reads the flag from the UI store. Making the field
    // required prevents a future caller from silently dropping the filter by
    // forgetting to pass it.
    hideDefaultBranchWorkspace: boolean
    hideAutomationGeneratedWorkspaces: boolean
    hideCliCreatedWorkspaces: boolean
    hideDetachedHeadWorkspaces: boolean
    // Why optional here, against the "why required" rule above: omitting it
    // must fail *open*. A caller that forgets the flag then shows an extra row
    // instead of silently re-hiding the project's entry point, which is the
    // exact regression #8873 reports.
    alwaysShowDefaultBranchWorkspace?: boolean
    repoMap: Map<string, Repo>
    workspaceHostScope: ExecutionHostScope
    visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
    defaultHostId: ExecutionHostId
    worktreeLineageById: Record<string, WorktreeLineage>
    injectLineageAncestors?: boolean
    forcedVisibleWorktreeIds?: readonly string[]
  }
): string[] {
  let all: Worktree[] = getAllWorktreesFromState({ worktreesByRepo })

  // Filter archived
  all = all.filter((w) => !w.isArchived)

  // Why: sidebar lineage is structural. Archived workspaces stay hidden, but
  // every other valid ancestor can bypass filters so children never orphan.
  const lineageAncestorById = new Map(all.map((w) => [w.id, w]))

  if (opts.hideDefaultBranchWorkspace) {
    all = all.filter((w) => !isDefaultBranchWorkspace(w))
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
          opts.worktreeIdsWithLiveAgent
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
  const orderIndex = new Map(sortedIds.map((id, i) => [id, i]))
  all.sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? Infinity
    const bi = orderIndex.get(b.id) ?? Infinity
    return ai - bi
  })

  const visibleIds = all.map((w) => w.id)
  return opts.injectLineageAncestors === false
    ? visibleIds
    : addVisibleLineageAncestors(visibleIds, lineageAncestorById, opts.worktreeLineageById)
}

function addVisibleLineageAncestors(
  ids: string[],
  worktreeById: Map<string, Worktree>,
  lineageById: Record<string, WorktreeLineage>
): string[] {
  const result: string[] = []
  const included = new Set<string>()
  const visiting = new Set<string>()
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeById)

  const addWithAncestors = (id: string): void => {
    if (included.has(id) || visiting.has(id)) {
      return
    }
    const worktree = worktreeById.get(id)
    if (!worktree) {
      return
    }
    visiting.add(id)
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeById, cyclicLineageIds)
    if (lineage.state === 'valid') {
      // Why: sidebar lineage is structural. If a filtered child is visible,
      // its valid parent must be rendered too so the hierarchy remains legible.
      addWithAncestors(lineage.parent.id)
    }
    visiting.delete(id)
    if (!included.has(id)) {
      included.add(id)
      result.push(id)
    }
  }

  for (const id of ids) {
    addWithAncestors(id)
  }
  return result
}

/**
 * Module-level cache of the visible worktree IDs as last computed by
 * WorktreeList's render pipeline.
 *
 * Why: WorktreeList freezes its sort order via sortedIds / sortEpoch useMemo
 * and only re-sorts when sortEpoch bumps. If getVisibleWorktreeIds()
 * recomputes sort order from a live Zustand snapshot, the Cmd+1–9 shortcut
 * could target a different worktree than what's rendered at that sidebar
 * position. By caching the IDs that WorktreeList actually rendered, the
 * shortcut numbering always matches the sidebar card order.
 *
 * Why null vs []: [] is a real rendered order (everything collapsed/filtered);
 * null means WorktreeList is unmounted.
 */
let _publishedVisibleIds: string[] | null = null

/**
 * Called by WorktreeList after computing visible worktrees so the Cmd+1–9
 * handler can read the exact same ordering the user sees on screen. Pass null
 * on unmount.
 */
export function setVisibleWorktreeIds(ids: string[] | null): void {
  _publishedVisibleIds = ids
}

/**
 * Compute the visible worktree IDs on-demand from the current Zustand store
 * state. Called by the App-level Cmd+1–9 handler (not a React hook — reads
 * store snapshot at call time).
 *
 * If WorktreeList is mounted, returns the exact IDs it rendered. Otherwise
 * recomputes the order the sidebar *would* render from the same row pipeline,
 * so a closed sidebar numbers workspaces the same way an open one does (#9497).
 */
export function getVisibleWorktreeIds(): string[] {
  // Prefer the published IDs that mirror the rendered sidebar order.
  if (_publishedVisibleIds) {
    return _publishedVisibleIds
  }

  const state = useAppStore.getState()
  const allWorktrees = getAllWorktreesFromState(state).filter((w) => !w.isArchived)

  // Hoist repoMap so it's built once and reused across all branches below.
  const repoMap = getRepoMapFromState(state)

  let sortedIds: string[]

  if (state.sortBy === 'smart') {
    sortedIds = sortWorktreesSmart(
      allWorktrees,
      state.tabsByWorktree,
      repoMap,
      state.agentStatusByPaneKey,
      state.runtimePaneTitlesByTabId,
      state.ptyIdsByTabId,
      state.migrationUnsupportedByPtyId,
      state.terminalLayoutsByTabId
    ).map((w) => w.id)
  } else {
    // Why empty map: non-smart branches don't read attentionByWorktree, but
    // the param is required to keep smart-mode callers honest at the type level.
    const sorted = [...allWorktrees].sort(
      buildWorktreeComparator(state.sortBy, repoMap, Date.now(), new Map())
    )
    sortedIds = sorted.map((w) => w.id)
  }

  const visibleIds = computeVisibleWorktreeIds(state.worktreesByRepo, sortedIds, {
    filterRepoIds: state.filterRepoIds,
    showSleepingWorkspaces: state.showSleepingWorkspaces,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    browserTabsByWorktree: state.browserTabsByWorktree,
    worktreeIdsWithLiveAgent: getWorktreeIdsWithLiveAgent(
      state.agentStatusByPaneKey,
      state.tabsByWorktree,
      Date.now()
    ),
    hideDefaultBranchWorkspace: state.hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces: state.hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces: state.hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: state.hideDetachedHeadWorkspaces,
    alwaysShowDefaultBranchWorkspace: state.alwaysShowDefaultBranchWorkspace,
    repoMap,
    workspaceHostScope: state.workspaceHostScope,
    visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
    defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
    worktreeLineageById: state.worktreeLineageById
  })

  const worktreeMap = getWorktreeMapFromState(state)
  // Why the row pipeline: grouping, pinning and main-worktree hoisting reorder cards, so a flat sort numbers the wrong workspace.
  return computeRenderedSidebarWorktreeOrder(
    state,
    visibleIds.map((id) => worktreeMap.get(id)).filter((w): w is Worktree => w != null)
  )
}
