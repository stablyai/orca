import type { AppState } from '@/store/types'
import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardDotState,
  DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { applyAgentRowLineage } from './agent-row-lineage'
import type { DashboardAgentRow } from './useDashboardData'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectTerminalLayoutsForWorktree
} from '../sidebar/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'

/** The store slices the snapshot builder reads. Kept as a Pick so unit tests
 *  can pass a partial store without constructing the whole AppState. */
export type DashboardSnapshotState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'acknowledgedAgentsByPaneKey'
>

function bucketForState(state: DashboardAgentRow['state']): DashboardBucket {
  switch (state) {
    case 'working':
      return 'working'
    // 'done' folds into Idle — it's only reported when a completion hook fires,
    // so it's not a reliable standalone column. The card keeps a done dot.
    case 'done':
    case 'idle':
      return 'idle'
    // blocked | waiting — the agent needs the user.
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

function rowTask(row: DashboardAgentRow): string {
  return (row.entry.orchestration?.taskTitle ?? '').trim() || (row.entry.prompt ?? '').trim()
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Derive the serializable dashboard snapshot from the live renderer store.
 * Reuses the exact per-worktree row machinery the sidebar uses
 * (buildWorktreeAgentRows + the indexed selectors), then flattens every
 * worktree's rows into presentational cards. Subagent/child rows are excluded
 * from the board (out of scope for v1).
 */
export function buildDashboardSnapshot(
  state: DashboardSnapshotState,
  now: number
): DashboardSnapshot {
  const cards: DashboardCard[] = []

  for (const repo of state.repos ?? []) {
    for (const worktree of state.worktreesByRepo?.[repo.id] ?? []) {
      if (worktree.isArchived) {
        continue
      }
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

      const rows = applyAgentRowLineage(
        buildWorktreeAgentRows({
          tabs: state.tabsByWorktree[worktreeId] ?? [],
          entries,
          retained: selectRetainedAgentEntriesForWorktree(state, worktreeId),
          runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, worktreeId),
          ptyIdsByTabId: selectLivePtyIdsForWorktree(state, worktreeId),
          terminalLayoutsByTabId,
          runtimeAgentOrchestrationByPaneKey: selectRuntimeAgentOrchestrationForWorktree(
            state,
            worktreeId
          ),
          now
        })
      )

      for (const row of rows) {
        // Child rows have no pane of their own; the board lists top-level agents.
        if (row.rowSource === 'subagent') {
          continue
        }
        // Title-derived rows (a live pane read only from its terminal title, no
        // agent-hook status) carry synthetic prompt/lastAssistantMessage — the
        // agent LABEL and a status word like "Idle". They're marked by
        // startedAt === 0, and must NOT be shown as real conversation.
        const isTitleDerived = row.startedAt === 0
        const routingPaneKey = row.activationPaneKey ?? row.paneKey
        const parsed = parsePaneKey(routingPaneKey)
        const tabId = parsed?.tabId ?? row.tab.id
        const leafId = parsed?.leafId ?? null
        const layoutPtyId =
          (leafId ? terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] : undefined) ?? null
        // Layout entries survive app restarts, but their PTYs may not (parked
        // tabs keep the pre-restart id). Only advertise a pty the terminal
        // preview can actually serialize — ptyIdsByTabId is the liveness truth.
        const ptyId =
          layoutPtyId && (state.ptyIdsByTabId?.[tabId] ?? []).includes(layoutPtyId)
            ? layoutPtyId
            : null
        const dotState = row.state as DashboardCardDotState
        const bucket = bucketForState(row.state)

        cards.push({
          paneKey: row.paneKey,
          ptyId,
          agentType: row.agentType,
          bucket,
          dotState,
          task: isTitleDerived ? '' : rowTask(row),
          repoId: repo.id,
          worktreeId,
          tabId,
          leafId,
          repoName: repo.displayName,
          worktreeName: worktree.displayName,
          lastUserMessage: isTitleDerived ? undefined : nonEmpty(row.entry.prompt),
          lastAgentMessage: isTitleDerived ? undefined : nonEmpty(row.entry.lastAssistantMessage),
          startedAt: row.startedAt,
          stateChangedAt: row.entry.stateStartedAt || row.startedAt,
          // Same derivation as WorktreeCardAgents' unvisitedByPaneKey, so the
          // board and the sidebar bold/mute the same agents at the same time.
          unseen:
            !isTitleDerived &&
            (state.acknowledgedAgentsByPaneKey?.[row.paneKey] ?? 0) < row.entry.stateStartedAt,
          askSummary:
            bucket === 'attention' ? (row.entry.interactivePrompt ?? undefined) : undefined
        })
      }
    }
  }

  return { generatedAt: now, cards }
}
