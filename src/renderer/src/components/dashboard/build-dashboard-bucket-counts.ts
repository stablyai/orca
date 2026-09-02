import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import { collectActiveDashboardWorkspaces } from './dashboard-snapshot-workspaces'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'
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

export type DashboardBucketCountsCache = WorktreeAgentRowsCache

export function createDashboardBucketCountsCache(): DashboardBucketCountsCache {
  return createWorktreeAgentRowsCache()
}

/**
 * Derive sidebar counts without allocating dashboard cards or metadata.
 *
 * With a cache, each worktree's row pipeline reruns only when one of its own
 * inputs changed (see worktree-agent-rows-cache). Counting over the (possibly
 * reused) rows happens on every call, so acknowledgement changes recount
 * without rebuilding any rows. `generation` must change whenever time-based
 * freshness decay may have shifted a bucket (agentStatusEpoch).
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
  const activeWorktrees = collectActiveDashboardWorkspaces(state, false)
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
    for (const row of rows) {
      if (row.rowSource === 'subagent') {
        continue
      }
      counts[dashboardRowBucketProjection(row, state.acknowledgedAgentsByPaneKey).bucket] += 1
    }
  }

  if (cache) {
    finishWorktreeAgentRowsCachePass(cache)
  }

  return counts.attention === 0 && counts.working === 0 && counts.done === 0 && counts.idle === 0
    ? EMPTY_COUNTS
    : counts
}
