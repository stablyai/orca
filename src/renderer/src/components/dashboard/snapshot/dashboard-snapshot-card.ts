import { agentVerdictDisplayMark } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { interactivePromptLabel } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { sayNativeChatApprovalTranslated } from '../../native-chat/prompts/native-chat-interactive-prompt'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type {
  DashboardCard,
  DashboardCardSubagent
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { DashboardAgentRow } from '../rows/dashboard-agent-row'
import { dashboardCardParentPaneKey } from '../rows/agent-row-lineage'
import { lastEnteredDoneAt } from '../rows/agent-finished-timestamp'
import { dashboardRowBucketProjection, readAgentRowTurnRecords } from '../rows/dashboard-row-bucket'
import { resolveDashboardCardTerminalInput } from './dashboard-card-terminal-input'
import type { DashboardClientHost } from './dashboard-client-host'
import type { DashboardCardContext } from './dashboard-card-context'
import {
  dashboardCardMapWorkspaceMetadata,
  type ActiveDashboardWorkspace
} from './dashboard-snapshot-workspaces'
import {
  boundedLabel,
  boundedLabelOrUndefined,
  nonEmpty,
  rowConversationName,
  rowTask
} from './dashboard-card-labels'
import type { DashboardSnapshotInput } from './build-dashboard-snapshot'
import type { selectTerminalLayoutsForWorktree } from '../../sidebar/workspace-card/activity/worktree-agent-row-selectors'
import type { selectRuntimePaneTitlesForWorktree } from '../../sidebar/workspace-card/activity/worktree-card-status-inputs'

export function buildDashboardSnapshotCard(args: {
  state: DashboardSnapshotInput
  workspace: ActiveDashboardWorkspace
  row: DashboardAgentRow
  includeCardDetails: boolean
  context: DashboardCardContext | undefined
  subagents: DashboardCardSubagent[] | undefined
  clientHost: DashboardClientHost
  terminalLayoutsByTabId: ReturnType<typeof selectTerminalLayoutsForWorktree>
  paneTitlesByTabId: ReturnType<typeof selectRuntimePaneTitlesForWorktree>
}): DashboardCard {
  const {
    state,
    workspace,
    row,
    includeCardDetails,
    context,
    subagents,
    clientHost,
    terminalLayoutsByTabId,
    paneTitlesByTabId
  } = args
  const { worktree } = workspace
  const worktreeId = worktree.id
  const parentWorktreeId = worktree.parentWorktreeId
  const turnRecords = readAgentRowTurnRecords(state)
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true
  // Title-derived rows contain synthetic prompt/message labels, not real conversation; startedAt=0 distinguishes them.
  const { isTitleDerived, dotState, workingMode, unseen, bucket } = dashboardRowBucketProjection(
    row,
    turnRecords
  )
  const routingPaneKey = row.activationPaneKey ?? row.paneKey
  const parsed = parsePaneKey(routingPaneKey)
  const tabId = parsed?.tabId ?? row.tab.id
  const leafId = parsed?.leafId ?? null
  const layoutPtyId =
    (leafId ? terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] : undefined) ?? null
  // Layouts survive restarts; advertise preview PTYs only when the live ptyIdsByTabId set still contains them.
  const ptyId =
    layoutPtyId && (state.ptyIdsByTabId?.[tabId] ?? []).includes(layoutPtyId) ? layoutPtyId : null
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

  const card: DashboardCard = {
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
    subagents: subagents,
    lastUserMessage: isTitleDerived ? undefined : nonEmpty(row.entry.prompt),
    lastAgentMessage: isTitleDerived ? undefined : nonEmpty(row.entry.lastAssistantMessage),
    startedAt: row.startedAt,
    finishedAt,
    stateChangedAt: row.entry.stateStartedAt || row.startedAt,
    statusUpdatedAt: row.entry.updatedAt,
    unseen,
    askSummary:
      bucket === 'attention'
        ? interactivePromptLabel(
            row.entry.interactivePrompt,
            row.entry.toolName,
            row.agentType,
            sayNativeChatApprovalTranslated
          )
        : undefined,
    conversationName: boundedLabelOrUndefined(
      rowConversationName(
        row,
        generatedTitlesEnabled,
        terminalLayoutsByTabId[row.tab.id],
        paneTitlesByTabId[row.tab.id],
        state.chatNames,
        state.unifiedTabsByWorktree,
        state.agentStatusByPaneKey
      )
    ),
    ...(terminalInput ? { terminalInput } : {})
  }
  return card
}
