import type { Repo } from '../../../../../../shared/repo-types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { FilterAgentIds } from '../../../../../../shared/workspace-agent-filter'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../../../shared/execution-host'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { selectVisibleSidebarWorktrees } from '../../../../../../shared/sidebar-list/visible-worktrees'
import { buildDesktopWorkspaceRowFactReader } from './desktop-workspace-row-facts'
import { sidebarWorkspaceRowFilters } from '../controls/sidebar-filter-actions'
import { getLineageAncestorIndex, getSortedWorktreeRankIndex } from './visible-worktree-indexes'
import { filterWorktreesBySelectedAgents } from '../../workspace-agent-filter-evidence'

// Separate store binding avoids attention-slice import cycles; shared builders retain the filter rules.

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
  filterAgentIds?: FilterAgentIds
  agentTypesByWorktree?: Record<string, readonly (string | null | undefined)[]> | null
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>> | null
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined> | null
  repoMap: Map<string, Repo>
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  worktreeLineageById: Record<string, WorktreeLineage>
  injectLineageAncestors?: boolean
  preserveLineageParentOrder?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
  /** The sorted keys are host identities (the stamp sort's), not bare ids, so a same-id pair keeps two ranks. */
  sortedByHostIdentity?: boolean
  /** Exempt from the sleeping sweep only; unlike forcedVisibleWorktreeIds, every other filter still applies. */
  sleepingSweepExemptWorktreeIds?: ReadonlySet<string>
}

export function computeVisibleWorktrees(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedKeys: readonly string[],
  opts: VisibleWorktreeOptions
): Worktree[] {
  const rankByKey = getSortedWorktreeRankIndex(sortedKeys)
  const keyOf = opts.sortedByHostIdentity
    ? getWorktreeHostIdentity
    : (worktree: Worktree) => worktree.id
  let rows = getIndexedAllWorktrees(worktreesByRepo)
  // Why before the shared filters: host twins must still be in the list so agent
  // evidence stays on the host that published it.
  if (opts.filterAgentIds) {
    rows = filterWorktreesBySelectedAgents(rows, opts.filterAgentIds, {
      tabsByWorktree: opts.tabsByWorktree,
      agentTypesByWorktree: opts.agentTypesByWorktree,
      runtimePaneTitlesByTabId: opts.runtimePaneTitlesByTabId,
      terminalLayoutsByTabId: opts.terminalLayoutsByTabId
    })
  }
  return selectVisibleSidebarWorktrees({
    rows,
    ancestorByIdentity: getLineageAncestorIndex(worktreesByRepo),
    rankOf: (worktree) => rankByKey.get(keyOf(worktree)),
    filters: sidebarWorkspaceRowFilters(opts),
    facts: buildDesktopWorkspaceRowFactReader(opts),
    worktreeLineageById: opts.worktreeLineageById,
    filterRepoIds: opts.filterRepoIds,
    injectLineageAncestors: opts.injectLineageAncestors,
    preserveLineageParentOrder: opts.preserveLineageParentOrder,
    forcedVisibleWorktreeIds: opts.forcedVisibleWorktreeIds
  })
}

export function computeVisibleWorktreeIds(
  worktreesByRepo: Record<string, Worktree[]>,
  sortedKeys: readonly string[],
  opts: VisibleWorktreeOptions
): string[] {
  return computeVisibleWorktrees(worktreesByRepo, sortedKeys, opts).map((worktree) => worktree.id)
}
