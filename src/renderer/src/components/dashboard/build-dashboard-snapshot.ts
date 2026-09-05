import type { AppState } from '@/store/types'
import {
  DASHBOARD_MAX_MAP_WORKSPACES,
  type DashboardCard,
  type DashboardSnapshot,
  type DashboardWorkspace
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveDashboardCardTerminalInput,
  type DashboardCardTerminalInputState
} from './dashboard-card-terminal-input'
import { readDashboardClientHost } from './dashboard-client-host'
import { dashboardCardParentPaneKey } from './agent-row-lineage'
import { lastEnteredDoneAt } from './agent-finished-timestamp'
import { selectTerminalLayoutsForWorktree } from '../sidebar/worktree-agent-row-selectors'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'
import {
  finishWorktreeAgentRowsCachePass,
  selectWorktreeAgentRowsCached,
  startWorktreeAgentRowsCachePass,
  type WorktreeAgentRowsCache
} from './worktree-agent-rows-cache'
import { selectRuntimePaneTitlesForWorktree } from '../sidebar/worktree-card-status-inputs'
import {
  resolveDashboardCardContext,
  type DashboardCardContextState
} from './dashboard-card-context'
import {
  collectActiveDashboardWorkspaces,
  dashboardCardMapWorkspaceMetadata
} from './dashboard-snapshot-workspaces'
import {
  boundedLabel,
  boundedLabelOrUndefined,
  nonEmpty,
  rowConversationName,
  rowTask
} from './dashboard-card-labels'
import {
  buildDashboardWorktreeLaunchOptions,
  type DashboardLaunchDetectionState
} from './dashboard-worktree-launch-options'
import { buildDashboardSnapshotFilterOptions } from './dashboard-snapshot-filter-options'
import { groupSubagentsByParentPaneKey } from './dashboard-subagent-cards'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'

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
  Partial<
    DashboardCardTerminalInputState &
      DashboardLaunchDetectionState &
      Pick<AppState, 'runtimeEnvironments' | 'sshTargetLabels' | 'unifiedTabsByWorktree'>
  >

/**
 * Derive the serializable dashboard snapshot from the live renderer store.
 * Reuses the exact per-worktree row machinery the sidebar uses
 * (buildWorktreeAgentRows + the indexed selectors), then flattens every
 * worktree's rows into presentational cards. Provider subagents without their
 * own terminal stay folded into their spawning card.
 */
export function buildDashboardSnapshot(
  state: DashboardSnapshotState,
  now: number,
  options: {
    includeCardDetails?: boolean
    includeFilterOptions?: boolean
    /** Optional per-worktree row-pipeline reuse; card assembly always runs fresh
     *  because cards also read review/host/status slices the cache does not key. */
    rowsCache?: WorktreeAgentRowsCache
    /** Freshness token for rowsCache (agentStatusEpoch); required for the cache to be safe. */
    rowsGeneration?: unknown
  } = {}
): DashboardSnapshot {
  const cards: DashboardCard[] = []
  const workspaces: DashboardWorkspace[] | undefined =
    options.includeCardDetails === false ? undefined : []
  const clientHost = readDashboardClientHost()
  const repoIconsByRepoId: Record<string, RepoIcon | null> = {}
  const includeCardDetails = options.includeCardDetails !== false
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  const showIdle = state.settings?.experimentalAgentDashboardShowIdle === true
  const activeWorktrees = collectActiveDashboardWorkspaces(state, includeCardDetails)
  const filterOptions =
    options.includeFilterOptions === false
      ? undefined
      : buildDashboardSnapshotFilterOptions(state, activeWorktrees)
  const { singletonOrchestration, orchestrationByWorktree } = selectDashboardOrchestration(
    state,
    activeWorktrees
  )
  if (options.rowsCache) {
    startWorktreeAgentRowsCachePass(options.rowsCache)
  }

  for (const workspace of activeWorktrees) {
    const { repo, worktree } = workspace
    const worktreeId = worktree.id
    const parentWorktreeId = worktree.parentWorktreeId
    const terminalLayoutsByTabId = selectTerminalLayoutsForWorktree(state, worktreeId)
    const paneTitlesByTabId = selectRuntimePaneTitlesForWorktree(state, worktreeId)

    const rows = selectWorktreeAgentRowsCached({
      state,
      worktreeId,
      orchestration:
        singletonOrchestration ??
        orchestrationByWorktree?.get(worktreeId) ??
        EMPTY_WORKTREE_AGENT_ORCHESTRATION,
      now,
      generation: options.rowsGeneration,
      cache: options.rowsCache
    })
    const subagentsByParentPaneKey = includeCardDetails
      ? groupSubagentsByParentPaneKey(rows)
      : undefined
    const context = includeCardDetails
      ? resolveDashboardCardContext(state, repo, worktree)
      : undefined
    if (workspaces && workspaces.length < DASHBOARD_MAX_MAP_WORKSPACES) {
      const hostMetadata = dashboardCardMapWorkspaceMetadata(
        workspace,
        null,
        undefined,
        clientHost.platform
      )
      workspaces.push({
        repoId: workspace.projectId,
        worktreeId,
        repoName: boundedLabel(workspace.projectName),
        worktreeName: boundedLabel(worktree.displayName),
        ...(parentWorktreeId ? { parentWorktreeId } : {}),
        ...hostMetadata,
        workspaceStatusId: context?.workspaceStatus.id,
        workspaceStatusLabel: context?.workspaceStatus.label,
        workspaceStatusColor: context?.workspaceStatus.color,
        hasReview: context?.hasReview,
        review: context?.review
      })
    }

    for (const row of rows) {
      // Child rows have no pane of their own; the board lists top-level agents.
      if (row.rowSource === 'subagent') {
        continue
      }
      // Title-derived rows (a live pane read only from its terminal title, no
      // agent-hook status) carry synthetic prompt/lastAssistantMessage — the
      // agent LABEL and a status word like "Idle". They're marked by
      // startedAt === 0, and must NOT be shown as real conversation.
      const { isTitleDerived, dotState, workingMode, unseen, bucket } =
        dashboardRowBucketProjection(row, state.acknowledgedAgentsByPaneKey)
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
      // A local row without a live PTY cannot be opened or focused. Do not
      // publish dead cards; remote absence is only unverifiable and stays visible.
      if (includeCardDetails && !ptyId && workspace.remoteHostKind === null) {
        continue
      }
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
      const finishedAt = lastEnteredDoneAt(row)
      const hostMetadata = includeCardDetails
        ? dashboardCardMapWorkspaceMetadata(
            workspace,
            ptyId,
            terminalInput ?? undefined,
            clientHost.platform
          )
        : undefined
      // Only repos that actually contribute a card ship their icon.
      repoIconsByRepoId[workspace.projectId] = workspace.repoIcon

      cards.push({
        paneKey: row.paneKey,
        ptyId,
        agentType: row.agentType,
        bucket,
        dotState,
        ...(workingMode ? { workingMode } : {}),
        task: isTitleDerived ? '' : rowTask(row),
        repoId: workspace.projectId,
        worktreeId,
        tabId,
        leafId,
        repoName: boundedLabel(workspace.projectName),
        worktreeName: boundedLabel(worktree.displayName),
        ...(includeCardDetails
          ? {
              parentPaneKey: dashboardCardParentPaneKey(row),
              ...(parentWorktreeId ? { parentWorktreeId } : {}),
              ...hostMetadata
            }
          : {}),
        workspaceStatusId: context?.workspaceStatus.id,
        workspaceStatusLabel: context?.workspaceStatus.label,
        workspaceStatusColor: context?.workspaceStatus.color,
        hasReview: context ? context.hasReview || context.review !== undefined : undefined,
        review: context?.review,
        subagents: subagentsByParentPaneKey?.get(row.paneKey),
        lastUserMessage: isTitleDerived ? undefined : nonEmpty(row.entry.prompt),
        lastAgentMessage: isTitleDerived ? undefined : nonEmpty(row.entry.lastAssistantMessage),
        startedAt: row.startedAt,
        finishedAt,
        stateChangedAt: row.entry.stateStartedAt || row.startedAt,
        statusUpdatedAt: row.entry.updatedAt,
        // Same derivation as WorktreeCardAgents' unvisitedByPaneKey, so the
        // board and the sidebar bold/mute the same agents at the same time.
        unseen,
        askSummary: bucket === 'attention' ? (row.entry.interactivePrompt ?? undefined) : undefined,
        conversationName: boundedLabelOrUndefined(
          rowConversationName(
            row,
            generatedTitlesEnabled,
            terminalLayoutsByTabId[row.tab.id],
            paneTitlesByTabId[row.tab.id]
          )
        ),
        ...(terminalInput ? { terminalInput } : {})
      })
    }
  }

  if (options.rowsCache) {
    finishWorktreeAgentRowsCachePass(options.rowsCache)
  }

  return {
    generatedAt: now,
    cards,
    ...(workspaces ? { workspaces } : {}),
    showIdle,
    filterOptions,
    // Only the dashboard surfaces offer a launcher; the count-only rebuild that
    // feeds the sidebar must not pay for host-detection lookups.
    ...(includeCardDetails
      ? {
          launchableAgentsByWorktreeId: buildDashboardWorktreeLaunchOptions(
            state,
            cards,
            workspaces
          )
        }
      : {}),
    repoIconsByRepoId
  }
}
