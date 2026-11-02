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

  // Why: persisted or remote worktree state can briefly omit displayName after
  // a custom workspace name is removed; sorting must stay render-safe.
  const pathLabel =
    typeof worktree.path === 'string' ? getRuntimePathBasename(worktree.path).trim() : ''
  return pathLabel || worktree.id
}

/**
 * Sort labels precomputed once per sort, so the O(N log N) comparator does O(1)
 * lookups instead of re-deriving both labels on every comparison.
 *
 * Why keyed on the row and not its id: a two-host id collision (STA-4343) puts
 * two rows with different paths under one id, and an id key would hand one of
 * them the other's label.
 */
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

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 *
 * Smart mode requires `attentionByWorktree` — a per-worktree class +
 * timestamp map built once before sorting (see `buildAttentionByWorktree`).
 * Why non-optional: a forgotten caller would silently regress every worktree
 * to Class 5 (idle) and degrade the comparator to recent-activity ordering;
 * making the param required surfaces the omission as a typecheck error.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  repoMap: Map<string, Pick<Repo, 'displayName'>>,
  now: number,
  attentionByWorktree: Map<string, WorktreeAttention>,
  labels?: WorktreeSortLabels
): (a: Worktree, b: Worktree) => number {
  const read = {
    label: (worktree: Worktree): string => labels?.get(worktree) ?? getWorktreeSortLabel(worktree),
    identity: getWorktreeHostIdentity,
    repoLabel: (worktree: Worktree) => repoMap.get(worktree.repoId)?.displayName ?? '',
    // Why fallback to sortOrder: existing users have a persisted smart-sort snapshot but no
    // manualOrder yet, so Manual starts from that order instead of alphabetizing.
    manualRank: (worktree: Worktree) => worktree.manualOrder ?? worktree.sortOrder
  }
  // Switch point: Recent and Smart read the owning host's stamps, with no clock.
  if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return buildWorkspaceRowComparator<Worktree>(sortBy, {
      ...read,
      recentActivity: recentStamp,
      compareSmart: compareSmartStamps
    })
  }
  return buildWorkspaceRowComparator<Worktree>(sortBy, {
    ...read,
    recentActivity: (worktree) => effectiveRecentActivity(worktree, now),
    compareSmart: (a, b) => {
      const aw = attentionByWorktree.get(a.id) ?? IDLE
      const bw = attentionByWorktree.get(b.id) ?? IDLE
      return (
        // Why: 1 < 2 < 3 < 4 < 5 — lower class outranks higher.
        aw.cls - bw.cls ||
        // Why: within a class, the more recent attention event ranks first.
        bw.attentionTimestamp - aw.attentionTimestamp ||
        // Why: idle worktrees fall through to recency (and the create-grace
        // floor for brand-new worktrees) before alphabetical.
        effectiveRecentActivity(b, now) - effectiveRecentActivity(a, now)
      )
    }
  })
}

/**
 * Sort worktrees by the smart-attention comparator (status class first,
 * recency-of-attention second). On cold start (no live PTYs yet), falls back
 * to persisted `sortOrder` descending so the sidebar restores the pre-quit
 * order until the agent-status snapshot lands.
 *
 * Both the palette and `getVisibleWorktreeIds()` import this to avoid
 * duplicating the cold/warm branching logic.
 *
 * `agentStatusByPaneKey` carries the primary signal; `runtimePaneTitlesByTabId`
 * and `ptyIdsByTabId` enable the title-heuristic fallback for hookless agents
 * (Edge case 9 in the design doc). Why all three are non-optional: a forgotten
 * caller would silently regress every worktree to Class 5 or quietly disable
 * the hookless-fallback path.
 */
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

export type WorktreeSortRanking<W extends Worktree> = {
  sorted: W[]
  /** Smart only, and only once warm. */
  attentionByWorktree: Map<string, WorktreeAttention> | null
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
    worktrees.sort(buildWorktreeComparator(sortBy, args.repoMap, now, new Map(), labels))
    return { sorted: worktrees, attentionByWorktree: null, detectedLiveSmartSignal: false }
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
      return { sorted: worktrees, attentionByWorktree: null, detectedLiveSmartSignal: false }
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
  return {
    sorted: worktrees,
    attentionByWorktree: sortBy === 'smart' ? attentionByWorktree : null,
    detectedLiveSmartSignal
  }
}
