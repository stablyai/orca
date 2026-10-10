import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  collectActiveDashboardWorkspaces,
  type ActiveDashboardWorkspace,
  type DashboardWorkspaceState
} from './dashboard-snapshot-workspaces'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'
import type { DashboardAgentRowWithLineage } from './agent-row-lineage'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'
import {
  createWorktreeAgentRowsCache,
  finishWorktreeAgentRowsCachePass,
  selectWorktreeAgentRowsCached,
  startWorktreeAgentRowsCachePass,
  type WorktreeAgentRowsCache
} from './worktree-agent-rows-cache'

const EMPTY_COUNTS: Record<DashboardBucket, number> = {
  attention: 0,
  working: 0,
  done: 0,
  idle: 0
}

type ActiveWorkspacesMemo = {
  repos: unknown
  worktreesByRepo: unknown
  folderWorkspaces: unknown
  projectGroups: unknown
  workspaces: ActiveDashboardWorkspace[]
}

type WorktreeTallyMemo = {
  rows: readonly unknown[]
  acknowledgedAgentsByPaneKey: unknown
  tally: Record<DashboardBucket, number>
}

export type DashboardBucketCountsCache = WorktreeAgentRowsCache & {
  /** Memo over the metadata-free workspace collection; see selectActiveDashboardWorkspaces. */
  activeWorkspaces: ActiveWorkspacesMemo | null
  /** Per-worktree bucket tallies; see tallyWorktreeRows. */
  tallyByWorktree: Map<string, WorktreeTallyMemo>
  /** Previously returned totals, reused by identity when all four are unchanged. */
  lastCounts: Record<DashboardBucket, number> | null
}

export function createDashboardBucketCountsCache(): DashboardBucketCountsCache {
  return {
    ...createWorktreeAgentRowsCache(),
    activeWorkspaces: null,
    tallyByWorktree: new Map(),
    lastCounts: null
  }
}

/**
 * The workspace descriptor list, reused by identity while its inputs hold.
 *
 * `collectActiveDashboardWorkspaces(state, false)` allocates one descriptor per
 * workspace (hundreds, in a large install) and, with metadata off, reads only the
 * four slices keyed here — see the read-set note on `DashboardWorkspaceState`.
 * Every other slice it can touch sits behind an `includeMapMetadata` gate.
 */
function selectActiveDashboardWorkspaces(
  state: DashboardWorkspaceState,
  cache: DashboardBucketCountsCache | undefined
): ActiveDashboardWorkspace[] {
  const memo = cache?.activeWorkspaces
  if (
    memo &&
    memo.repos === state.repos &&
    memo.worktreesByRepo === state.worktreesByRepo &&
    memo.folderWorkspaces === state.folderWorkspaces &&
    memo.projectGroups === state.projectGroups
  ) {
    return memo.workspaces
  }
  const workspaces = collectActiveDashboardWorkspaces(state, false)
  if (cache) {
    cache.activeWorkspaces = {
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      workspaces
    }
  }
  return workspaces
}

function countsEqual(
  a: Record<DashboardBucket, number>,
  b: Record<DashboardBucket, number>
): boolean {
  return (
    a.attention === b.attention && a.working === b.working && a.done === b.done && a.idle === b.idle
  )
}

/**
 * One worktree's bucket tally, reused while its rows and the acknowledgement map
 * both hold their identity.
 *
 * `dashboardRowBucketProjection` reads nothing but the row and
 * `acknowledgedAgentsByPaneKey[row.paneKey]`, so those two identities are the
 * whole input. Keying on the ack slice rather than folding it into the row cache
 * keeps main's property that an acknowledgement recounts without rebuilding rows.
 */
function tallyWorktreeRows(
  rows: DashboardAgentRowWithLineage[],
  acknowledgedAgentsByPaneKey: Record<string, number> | undefined,
  worktreeId: string,
  cache: DashboardBucketCountsCache | undefined
): Record<DashboardBucket, number> {
  const memo = cache?.tallyByWorktree.get(worktreeId)
  if (
    memo &&
    memo.rows === rows &&
    memo.acknowledgedAgentsByPaneKey === acknowledgedAgentsByPaneKey
  ) {
    return memo.tally
  }
  const tally = { attention: 0, working: 0, done: 0, idle: 0 } satisfies Record<
    DashboardBucket,
    number
  >
  for (const row of rows) {
    if (row.rowSource === 'subagent') {
      continue
    }
    tally[dashboardRowBucketProjection(row, acknowledgedAgentsByPaneKey).bucket] += 1
  }
  cache?.tallyByWorktree.set(worktreeId, {
    rows,
    acknowledgedAgentsByPaneKey,
    tally
  })
  return tally
}

/**
 * Derive sidebar counts without allocating dashboard cards or metadata.
 *
 * With a cache, three layers reuse work independently: the workspace descriptor
 * list while its four slices hold, each worktree's row pipeline while its own
 * inputs hold (see worktree-agent-rows-cache), and each worktree's bucket tally
 * while its rows and the acknowledgement map hold. An acknowledgement write
 * therefore recounts without rebuilding any rows, as before. `generation` must
 * change whenever time-based freshness decay may have shifted a bucket
 * (agentStatusEpoch).
 */
export function buildDashboardBucketCounts(
  state: DashboardSnapshotState,
  now: number,
  cache?: DashboardBucketCountsCache,
  generation?: unknown
): Record<DashboardBucket, number> {
  const counts = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0
  } satisfies Record<DashboardBucket, number>
  const activeWorktrees = selectActiveDashboardWorkspaces(state, cache)
  const { singletonOrchestration, orchestrationByWorktree } = selectDashboardOrchestration(
    state,
    activeWorktrees
  )
  if (cache) {
    startWorktreeAgentRowsCachePass(cache)
  }

  for (const { worktree } of activeWorktrees) {
    const worktreeId = worktree.id
    const rows = selectWorktreeAgentRowsCached({
      state,
      worktreeId,
      orchestration:
        singletonOrchestration ??
        orchestrationByWorktree?.get(worktreeId) ??
        EMPTY_WORKTREE_AGENT_ORCHESTRATION,
      now,
      generation,
      cache
    })
    const tally = tallyWorktreeRows(rows, state.acknowledgedAgentsByPaneKey, worktreeId, cache)
    counts.attention += tally.attention
    counts.working += tally.working
    counts.done += tally.done
    counts.idle += tally.idle
  }

  if (cache) {
    for (const worktreeId of cache.tallyByWorktree.keys()) {
      if (!cache.seenWorktreeIds.has(worktreeId)) {
        cache.tallyByWorktree.delete(worktreeId)
      }
    }
    finishWorktreeAgentRowsCachePass(cache)
  }

  const totals =
    counts.attention === 0 && counts.working === 0 && counts.done === 0 && counts.idle === 0
      ? EMPTY_COUNTS
      : counts
  if (!cache) {
    return totals
  }
  // Why: most recomputes are triggered by agent traffic that leaves all four
  // totals where they were; a fresh object there would re-render the sidebar
  // entry and miss every downstream memo keyed on this result.
  const stable =
    cache.lastCounts && countsEqual(cache.lastCounts, totals) ? cache.lastCounts : totals
  cache.lastCounts = stable
  return stable
}
