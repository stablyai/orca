import type { Repo } from '../repo-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { Worktree } from '../worktree/types'
import type { AgentStatusEntry, MigrationUnsupportedPtyEntry } from '../agent-status-types'
import { tabHasLivePty } from '../tab-has-live-pty'
import { getRuntimePathBasename } from '../cross-platform-path'
import {
  buildWorkspaceRowComparator,
  recentActivityWithCreateGrace,
  type WorkspaceSortBy
} from '../workspace-view/workspace-row-sort'
import { compareCodePoints, compareSidebarText } from './text-order'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import {
  IDLE,
  buildAttentionByWorktree,
  hasFreshAttributedAgentStatus,
  type SmartAttentionTab,
  type WorktreeAttention
} from './smart-attention'
import { smartSortPhase } from './smart-sort-phase'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../sidebar-inputs-switch'
import { compareSmartStamps, recentStamp } from './stamp-order'

export type SortBy = WorkspaceSortBy

export { CREATE_GRACE_MS } from '../workspace-view/workspace-row-sort'

/** Recent-sort rank: `lastActivityAt`, floored at `createdAt + CREATE_GRACE_MS` while that window is open. */
export function effectiveRecentActivity(worktree: Worktree, now: number): number {
  return recentActivityWithCreateGrace(worktree.lastActivityAt, worktree.createdAt, now)
}

export type WorktreeSortLabelInput = Pick<Worktree, 'displayName' | 'path' | 'id' | 'hostId'>

export function getWorktreeSortLabel(worktree: WorktreeSortLabelInput): string {
  const displayName = typeof worktree.displayName === 'string' ? worktree.displayName.trim() : ''
  if (displayName) {
    return displayName
  }

  // Persisted/remote rows may omit displayName briefly after a rename clear; keep sorting render-safe.
  const pathLabel =
    typeof worktree.path === 'string' ? getRuntimePathBasename(worktree.path).trim() : ''
  return pathLabel || worktree.id
}

/** Precompute labels once for O(1) comparisons. Key by row object: same-ID cross-host rows can have different labels (STA-4343). */
export type WorktreeSortLabels = ReadonlyMap<WorktreeSortLabelInput, string>

export function buildWorktreeSortLabels<T extends WorktreeSortLabelInput>(
  worktrees: readonly T[]
): Map<WorktreeSortLabelInput, string> {
  const labels = new Map<WorktreeSortLabelInput, string>()
  for (const worktree of worktrees) {
    labels.set(worktree, getWorktreeSortLabel(worktree))
  }
  return labels
}

export function compareWorktreeSortLabel(
  a: WorktreeSortLabelInput,
  b: WorktreeSortLabelInput,
  labels?: WorktreeSortLabels
): number {
  return (
    compareSidebarText(
      labels?.get(a) ?? getWorktreeSortLabel(a),
      labels?.get(b) ?? getWorktreeSortLabel(b)
    ) || compareCodePoints(getWorktreeHostIdentity(a), getWorktreeHostIdentity(b))
  )
}

function worktreeSortReads(
  repoMap: Map<string, Pick<Repo, 'displayName'>>,
  labels: WorktreeSortLabels | undefined
) {
  return {
    label: (worktree: Worktree): string => labels?.get(worktree) ?? getWorktreeSortLabel(worktree),
    identity: getWorktreeHostIdentity,
    repoLabel: (worktree: Worktree) => repoMap.get(worktree.repoId)?.displayName ?? '',
    // Legacy users have sortOrder but no manualOrder; seed Manual from saved order instead of alphabetizing.
    manualRank: (worktree: Worktree) => worktree.manualOrder ?? worktree.sortOrder
  }
}

function buildStampComparator(
  sortBy: SortBy,
  repoMap: Map<string, Pick<Repo, 'displayName'>>,
  labels: WorktreeSortLabels | undefined
): (a: Worktree, b: Worktree) => number {
  return buildWorkspaceRowComparator<Worktree>(sortBy, {
    ...worktreeSortReads(repoMap, labels),
    recentActivity: recentStamp,
    compareSmart: compareSmartStamps
  })
}

/** Sorts in place by the owning hosts' stamps, reading no clock: the order every stamp reader shares. */
export function sortWorktreesByStamps<W extends Worktree>(
  worktrees: W[],
  sortBy: SortBy,
  repoMap: Map<string, Pick<Repo, 'displayName'>>
): W[] {
  return worktrees.sort(buildStampComparator(sortBy, repoMap, buildWorktreeSortLabels(worktrees)))
}

/** Require the precomputed attention map: omission would silently reduce Smart to idle/recent ordering. */
export function buildWorktreeComparator(
  sortBy: SortBy,
  repoMap: Map<string, Pick<Repo, 'displayName'>>,
  now: number,
  attentionByWorktree: Map<string, WorktreeAttention>,
  labels?: WorktreeSortLabels
): (a: Worktree, b: Worktree) => number {
  // Switch point: Recent and Smart read the owning host's stamps, with no clock.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return buildStampComparator(sortBy, repoMap, labels)
  }
  return buildWorkspaceRowComparator<Worktree>(sortBy, {
    ...worktreeSortReads(repoMap, labels),
    recentActivity: (worktree) => effectiveRecentActivity(worktree, now),
    compareSmart: (a, b) => {
      const aw = attentionByWorktree.get(a.id) ?? IDLE
      const bw = attentionByWorktree.get(b.id) ?? IDLE
      return (
        // Lower class outranks higher.
        aw.cls - bw.cls ||
        // Latest attention wins within a class.
        bw.attentionTimestamp - aw.attentionTimestamp ||
        // Idle falls back to recency/create grace before labels.
        effectiveRecentActivity(b, now) - effectiveRecentActivity(a, now)
      )
    }
  })
}

/** Share palette/sidebar Smart ordering: class then attention time; without live evidence use saved sortOrder.
 * Require hook/title/PTY sources so omitted callers cannot silently disable attention or hookless fallback. */
export function sortWorktreesSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  repoMap: Map<string, Repo>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>,
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
): Worktree[] {
  return rankWorktreesForSort({
    worktrees: [...worktrees],
    sortBy: 'smart',
    latched: false,
    repoMap,
    now: Date.now(),
    sources: {
      tabsByWorktree,
      agentStatusByPaneKey,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      migrationUnsupportedByPtyId,
      terminalLayoutsByTabId
    }
  }).sorted
}

/** What a Smart sort reads besides the rows; the window passes its store, main its own records. */
export type SmartSortSources = {
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  ptyIdsByTabId: Record<string, string[]>
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
}

/** For stamp-sorted callers: the stamps need no live terminal or agent sources. */
export const NO_LIVE_SMART_SORT_SOURCES: SmartSortSources = Object.freeze({
  tabsByWorktree: {},
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {}
})

export type WorktreeSortRanking<W extends Worktree> = {
  sorted: W[]
  /** True when this sort found the live signal that latches Smart for the list's lifetime. */
  detectedLiveSmartSignal: boolean
}

/** One frozen order for the active mode; the window and main both sort through here. */
export function rankWorktreesForSort<W extends Worktree>(args: {
  /** Non-archived rows; sorted in place. */
  worktrees: W[]
  sortBy: SortBy
  latched: boolean
  repoMap: Map<string, Pick<Repo, 'displayName'>>
  now: number
  sources: SmartSortSources
}): WorktreeSortRanking<W> {
  const { worktrees, sortBy, now, sources } = args
  // Why precompute: the label tiebreaker runs on every comparison in every mode.
  const labels = buildWorktreeSortLabels(worktrees)
  // Switch point: stamps need no cold phase, latch or attention map.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    worktrees.sort(buildStampComparator(sortBy, args.repoMap, labels))
    return { sorted: worktrees, detectedLiveSmartSignal: false }
  }
  let detectedLiveSmartSignal = false

  // Why cold-start detection: agent-status hydrates async, so the warm comparator would collapse all to Class 4; keep the persisted order until a live signal appears.
  if (smartSortPhase(sortBy, args.latched) === 'cold') {
    // Why tabHasLivePty over tab.ptyId: slept terminals keep tab.ptyId as a wake hint, so it'd falsely keep cold-start ordering off.
    const hasAnyLivePty = Object.values(sources.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tabHasLivePty(sources.ptyIdsByTabId, tab.id))
    )
    if (
      hasAnyLivePty ||
      hasFreshAttributedAgentStatus(sources.agentStatusByPaneKey, now, sources.tabsByWorktree)
    ) {
      detectedLiveSmartSignal = true
    } else {
      worktrees.sort((a, b) => b.sortOrder - a.sortOrder || compareWorktreeSortLabel(a, b, labels))
      return { sorted: worktrees, detectedLiveSmartSignal: false }
    }
  }

  // Why precompute: hot sort — build the attention map once so the O(N log N) comparator does O(1) lookups.
  const attentionByWorktree =
    sortBy === 'smart'
      ? buildAttentionByWorktree(
          worktrees,
          sources.tabsByWorktree,
          sources.agentStatusByPaneKey,
          sources.runtimePaneTitlesByTabId,
          sources.ptyIdsByTabId,
          now,
          sources.migrationUnsupportedByPtyId,
          sources.terminalLayoutsByTabId
        )
      : new Map<string, WorktreeAttention>()
  worktrees.sort(buildWorktreeComparator(sortBy, args.repoMap, now, attentionByWorktree, labels))
  return { sorted: worktrees, detectedLiveSmartSignal }
}
