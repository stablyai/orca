import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'
import type { StructuredChatTabNames } from '@/runtime/structured-chat-tab-name'
import type { AgentLaunchRouteView } from '@/lib/agent-launch-route-input'
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
import { dashboardRowBucketProjection, readAgentRowTurnRecords } from './dashboard-row-bucket'

/** Keep builder inputs as a Pick so tests need only construct the store slices read here. */
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

export type DashboardSnapshotInput = DashboardSnapshotState & { chatNames: StructuredChatTabNames }

/** Reuse sidebar row/index derivation for serializable cards; fold terminal-less subagents into their spawning card. */
export function buildDashboardSnapshot(
  state: DashboardSnapshotInput,
  now: number,
  options: {
    launchRouteStore?: AgentLaunchRouteView
    includeCardDetails?: boolean
    includeFilterOptions?: boolean
    /** Cache only row derivation; review/host/status inputs still require fresh card assembly. */
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
  const turnRecords = readAgentRowTurnRecords(state)
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
      // Title-derived rows contain synthetic prompt/message labels, not real conversation; startedAt=0 distinguishes them.
      const { isTitleDerived, dotState, workingMode, unseen, bucket } =
        dashboardRowBucketProjection(row, turnRecords)
      const routingPaneKey = row.activationPaneKey ?? row.paneKey
      const parsed = parsePaneKey(routingPaneKey)
      const tabId = parsed?.tabId ?? row.tab.id
      const leafId = parsed?.leafId ?? null
      const layoutPtyId =
        (leafId ? terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] : undefined) ?? null
      // Layouts survive restarts; advertise preview PTYs only when the live ptyIdsByTabId set still contains them.
      const ptyId =
        layoutPtyId && (state.ptyIdsByTabId?.[tabId] ?? []).includes(layoutPtyId)
          ? layoutPtyId
          : null
      // Only live preview-capable cards need host resolution; count-only sidebar rebuilds must skip that cost.
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
        verdict: agentVerdictDisplayMark(row.entry) ?? undefined,
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
        unseen,
        askSummary: bucket === 'attention' ? (row.entry.interactivePrompt ?? undefined) : undefined,
        conversationName: boundedLabelOrUndefined(
          rowConversationName(
            row,
            generatedTitlesEnabled,
            terminalLayoutsByTabId[row.tab.id],
            paneTitlesByTabId[row.tab.id],
            state.chatNames,
            state.unifiedTabsByWorktree
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
    // Count-only callers offer no launcher; skip host-detection lookups for sidebar rebuilds.
    ...(includeCardDetails
      ? {
          launchableAgentsByWorktreeId: buildDashboardWorktreeLaunchOptions(
            state,
            cards,
            workspaces,
            options.launchRouteStore
          )
        }
      : {}),
    repoIconsByRepoId
  }
}
