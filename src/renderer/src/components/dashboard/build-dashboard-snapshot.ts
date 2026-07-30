import type { AppState } from '@/store/types'
import {
  DASHBOARD_MAX_LABEL_LENGTH,
  type DashboardBucket,
  type DashboardCard,
  type DashboardCardDotState,
  type DashboardCardSubagent,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-statuses'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveDashboardCardTerminalInput,
  type DashboardCardTerminalInputState
} from './dashboard-card-terminal-input'
import { readDashboardClientHost } from './dashboard-client-host'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { applyAgentRowLineage } from './agent-row-lineage'
import { lastEnteredDoneAt } from './agent-finished-timestamp'
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
  EMPTY_WORKTREE_AGENT_ORCHESTRATION,
  releaseRuntimeAgentOrchestrationBatchCache,
  selectRuntimeAgentOrchestrationBatch
} from '../sidebar/worktree-agent-orchestration-batch'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'
import {
  resolveDashboardCardContext,
  type DashboardCardContextState
} from './dashboard-card-context'

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
  | 'settings'
> &
  DashboardCardContextState &
  Partial<DashboardCardTerminalInputState>

function bucketForState(state: DashboardAgentRow['state']): DashboardBucket {
  switch (state) {
    case 'working':
      return 'working'
    case 'done':
      return 'done'
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

/** Why: these labels come from unbounded sources (`terminal rename`, OSC titles,
 *  display names). Over the validator's bound the card would be dropped. */
function boundedLabel(value: string): string {
  return value.length > DASHBOARD_MAX_LABEL_LENGTH
    ? value.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
    : value
}

function boundedLabelOrUndefined(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedLabel(value)
}

/** Mirrors useAgentRowConversationName so the board and the sidebar label the
 *  same agent with the same name. */
function rowConversationName(
  row: DashboardAgentRow,
  generatedTitlesEnabled: boolean
): string | undefined {
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  // Why: a child row rendered on its parent's tab does not own that tab's name.
  if (
    row.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === row.tab.id
  ) {
    return undefined
  }
  return getAgentRowConversationName(row.tab, row.agentType, generatedTitlesEnabled) ?? undefined
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
  now: number,
  options: { includeCardDetails?: boolean; includeFilterOptions?: boolean } = {}
): DashboardSnapshot {
  const cards: DashboardCard[] = []
  const clientHost = readDashboardClientHost()
  const repoIconsByRepoId: Record<string, RepoIcon | null> = {}
  const includeCardDetails = options.includeCardDetails !== false
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const activeWorktrees: {
    repo: AppState['repos'][number]
    worktree: AppState['worktreesByRepo'][string][number]
  }[] = []

  for (const repo of state.repos ?? []) {
    for (const worktree of state.worktreesByRepo?.[repo.id] ?? []) {
      if (!worktree.isArchived) {
        activeWorktrees.push({ repo, worktree })
      }
    }
  }
  const filterOptions =
    options.includeFilterOptions === false
      ? undefined
      : {
          // Why: filterOptions is snapshot-level, so an over-long project label
          // costs the WHOLE board, not one card. Bound it at the producer.
          projects: [...new Map(activeWorktrees.map(({ repo }) => [repo.id, repo])).values()].map(
            (repo) => ({ id: repo.id, label: boundedLabel(repo.displayName) })
          ),
          workspaceStatuses: (state.workspaceStatuses && state.workspaceStatuses.length > 0
            ? state.workspaceStatuses
            : DEFAULT_WORKSPACE_STATUSES
          ).map((status) => ({
            id: status.id,
            label: status.label,
            color: status.color
          }))
        }
  let singletonOrchestration: ReturnType<typeof selectRuntimeAgentOrchestrationForWorktree> | null =
    null
  let orchestrationByWorktree: ReturnType<typeof selectRuntimeAgentOrchestrationBatch> | null = null
  if (activeWorktrees.length >= 2) {
    orchestrationByWorktree = selectRuntimeAgentOrchestrationBatch(
      state,
      activeWorktrees.map(({ worktree }) => worktree.id)
    )
  } else {
    releaseRuntimeAgentOrchestrationBatchCache()
    if (activeWorktrees.length === 1) {
      singletonOrchestration = selectRuntimeAgentOrchestrationForWorktree(
        state,
        activeWorktrees[0].worktree.id
      )
    }
  }

  for (const { repo, worktree } of activeWorktrees) {
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
        runtimeAgentOrchestrationByPaneKey:
          singletonOrchestration ??
          orchestrationByWorktree?.get(worktreeId) ??
          EMPTY_WORKTREE_AGENT_ORCHESTRATION,
        now
      })
    )
    const subagentsByParentPaneKey = includeCardDetails
      ? new Map<string, DashboardCardSubagent[]>()
      : undefined
    if (subagentsByParentPaneKey) {
      for (const row of rows) {
        if (row.rowSource !== 'subagent') {
          continue
        }
        const parentPaneKey = row.entry.orchestration?.parentPaneKey
        if (!parentPaneKey) {
          continue
        }
        const subagent: DashboardCardSubagent = {
          id: row.paneKey,
          name:
            nonEmpty(row.entry.orchestration?.displayName) ??
            nonEmpty(row.entry.prompt) ??
            row.agentType,
          dotState: row.state
        }
        const existing = subagentsByParentPaneKey.get(parentPaneKey)
        if (existing) {
          existing.push(subagent)
        } else {
          subagentsByParentPaneKey.set(parentPaneKey, [subagent])
        }
      }
    }
    const context = includeCardDetails
      ? resolveDashboardCardContext(state, repo, worktree)
      : undefined

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
      // Why: only a live pty can open a preview terminal, and only a
      // card-rendering caller can open one — the sidebar's bucket counts must
      // not pay host resolution on every agent-status tick.
      const terminalInput =
        ptyId && includeCardDetails
          ? resolveDashboardCardTerminalInput(state, {
              ptyId,
              worktreeId,
              paneKey: routingPaneKey,
              cwd: row.tab.startupCwd ?? worktree.path,
              shellOverride: row.tab.shellOverride,
              launchAgent: row.tab.launchAgent,
              clientPlatform: clientHost.platform,
              userAgent: clientHost.userAgent,
              osRelease: clientHost.osRelease
            })
          : null
      // Only repos that actually contribute a card ship their icon.
      repoIconsByRepoId[repo.id] = repo.repoIcon ?? null

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
        repoName: boundedLabel(repo.displayName),
        worktreeName: boundedLabel(worktree.displayName),
        workspaceStatusId: context?.workspaceStatus.id,
        workspaceStatusLabel: context?.workspaceStatus.label,
        workspaceStatusColor: context?.workspaceStatus.color,
        hasReview: context ? context.hasReview || context.review !== undefined : undefined,
        review: context?.review,
        subagents: subagentsByParentPaneKey?.get(row.paneKey),
        lastUserMessage: isTitleDerived ? undefined : nonEmpty(row.entry.prompt),
        lastAgentMessage: isTitleDerived ? undefined : nonEmpty(row.entry.lastAssistantMessage),
        startedAt: row.startedAt,
        finishedAt: lastEnteredDoneAt(row),
        stateChangedAt: row.entry.stateStartedAt || row.startedAt,
        // Same derivation as WorktreeCardAgents' unvisitedByPaneKey, so the
        // board and the sidebar bold/mute the same agents at the same time.
        unseen:
          !isTitleDerived &&
          (state.acknowledgedAgentsByPaneKey?.[row.paneKey] ?? 0) < row.entry.stateStartedAt,
        askSummary: bucket === 'attention' ? (row.entry.interactivePrompt ?? undefined) : undefined,
        conversationName: boundedLabelOrUndefined(rowConversationName(row, generatedTitlesEnabled)),
        ...(terminalInput ? { terminalInput } : {})
      })
    }
  }

  return {
    generatedAt: now,
    cards,
    showIdle: state.settings?.experimentalAgentDashboardShowIdle === true,
    filterOptions,
    repoIconsByRepoId
  }
}
