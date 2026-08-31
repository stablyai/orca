import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { applyAgentRowLineage } from './agent-row-lineage'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import { collectActiveDashboardWorkspaces } from './dashboard-snapshot-workspaces'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from '../sidebar/worktree-agent-row-selectors'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'

const EMPTY_COUNTS: Record<DashboardBucket, number> = {
  attention: 0,
  working: 0,
  done: 0,
  idle: 0
}

/** Derive sidebar counts without allocating dashboard cards or metadata. */
export function buildDashboardBucketCounts(
  state: DashboardSnapshotState,
  now: number
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

  for (const { worktree } of activeWorktrees) {
    const worktreeId = worktree.id
    const liveEntries = selectLiveAgentStatusEntriesForWorktree(state, worktreeId)
    const migrationUnsupported = selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
    const entries =
      migrationUnsupported.length > 0
        ? [
            ...liveEntries,
            ...migrationUnsupported.flatMap((unsupported) => {
              const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
              return entry ? [entry] : []
            })
          ]
        : liveEntries
    const terminalLayoutsByTabId = selectTerminalLayoutsForWorktree(state, worktreeId)
    const paneTitlesByTabId = selectRuntimePaneTitlesForWorktree(state, worktreeId)
    const rows = applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: state.tabsByWorktree[worktreeId] ?? [],
        entries,
        retained: selectRetainedAgentEntriesForWorktree(state, worktreeId),
        runtimePaneTitlesByTabId: paneTitlesByTabId,
        ptyIdsByTabId: selectLivePtyIdsForWorktree(state, worktreeId),
        terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey:
          singletonOrchestration ??
          orchestrationByWorktree?.get(worktreeId) ??
          EMPTY_WORKTREE_AGENT_ORCHESTRATION,
        now
      })
    )

    for (const row of rows) {
      if (row.rowSource === 'subagent') {
        continue
      }
      counts[dashboardRowBucketProjection(row, state.acknowledgedAgentsByPaneKey).bucket] += 1
    }
  }

  return counts.attention === 0 && counts.working === 0 && counts.done === 0 && counts.idle === 0
    ? EMPTY_COUNTS
    : counts
}
