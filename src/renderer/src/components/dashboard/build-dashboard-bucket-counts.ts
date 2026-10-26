import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  collectActiveDashboardWorkspaces,
  type ActiveDashboardWorkspace,
  type DashboardWorkspaceState
} from './dashboard-snapshot-workspaces'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import {
  dashboardRowBucketProjection,
  readAgentRowTurnRecords,
  type AgentRowUnreadState
} from './dashboard-row-bucket'
import type { DashboardAgentRowWithLineage } from './agent-row-lineage'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'
import {
  createWorktreeAgentRowsCache,
  finishWorktreeAgentRowsCachePass,
  selectWorktreeAgentRowsCached,
  startWorktreeAgentRowsCachePass,
  type WorktreeAgentRowsCache
} from './worktree-agent-rows-cache'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

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

/** Metadata-free descriptors read four slices only; extend this memo key whenever DashboardWorkspaceState’s ungated read set grows. */
function selectActiveDashboardWorkspaces(
  state: DashboardWorkspaceState,
  cache: DashboardBucketCountsCache | undefined
): ActiveDashboardWorkspace[] {
  const memo = cache?.activeWorkspaces
  if (
    memo &&
    memo.repos === state.repos &&
    memo.worktreesByRepo === selectWorktreesByRepo(state) &&
    memo.folderWorkspaces === state.folderWorkspaces &&
    memo.projectGroups === state.projectGroups
  ) {
    return memo.workspaces
  }
  const workspaces = collectActiveDashboardWorkspaces(state, false)
  if (cache) {
    cache.activeWorkspaces = {
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state),
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

/** Rows identity covers live/retained records; key acknowledgments separately so reading agents recounts without rebuilding rows. */
function tallyWorktreeRows(
  rows: DashboardAgentRowWithLineage[],
  state: AgentRowUnreadState,
  worktreeId: string,
  cache: DashboardBucketCountsCache | undefined
): Record<DashboardBucket, number> {
  const { acknowledgedAgentsByPaneKey } = state
  const memo = cache?.tallyByWorktree.get(worktreeId)
  if (
    memo &&
    memo.rows === rows &&
    memo.acknowledgedAgentsByPaneKey === acknowledgedAgentsByPaneKey
  ) {
    return memo.tally
  }
  const turnRecords = readAgentRowTurnRecords(state)
  const tally = { attention: 0, working: 0, done: 0, idle: 0 } satisfies Record<
    DashboardBucket,
    number
  >
  for (const row of rows) {
    if (row.rowSource === 'subagent') {
      continue
    }
    tally[dashboardRowBucketProjection(row, turnRecords).bucket] += 1
  }
  cache?.tallyByWorktree.set(worktreeId, {
    rows,
    acknowledgedAgentsByPaneKey,
    tally
  })
  return tally
}

/** Reuse workspace descriptors, per-worktree rows and ack-sensitive tallies independently; generation must advance on possible freshness decay. */
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
    const tally = tallyWorktreeRows(rows, state, worktreeId, cache)
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
  // Reuse equal totals by identity so status chatter cannot re-render sidebar consumers.
  const stable =
    cache.lastCounts && countsEqual(cache.lastCounts, totals) ? cache.lastCounts : totals
  cache.lastCounts = stable
  return stable
}
