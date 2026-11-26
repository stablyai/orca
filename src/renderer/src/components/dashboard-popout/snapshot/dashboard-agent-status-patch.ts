import { agentVerdictDisplayMark } from '../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { interactivePromptLabel } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { sayNativeChatApprovalTranslated } from '../../native-chat/prompts/native-chat-interactive-prompt'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  dashboardCardBaseDisplayState,
  type DashboardCard,
  type DashboardCardSubagent,
  type DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { dashboardBucketForDotState } from '../../dashboard/snapshot/dashboard-card-bucket'
import { dashboardCardDotState } from '../../dashboard/rows/dashboard-row-bucket'
import { isAgentTurnUnacknowledged } from '@/attention/agent-attention-acknowledgement'
import {
  dashboardCardIndex,
  replaceDashboardCards
} from '../../dashboard/snapshot/dashboard-card-changes'

export type DashboardAgentStatusPatchResult = {
  matched: boolean
  snapshot: DashboardSnapshot
}

function patchedSubagents(
  card: DashboardCard,
  event: AgentStatusIpcPayload
): DashboardCardSubagent[] | undefined {
  // Producers omit the field when the roster is empty, so absent means none, as the store reads it.
  return event.subagents?.map((subagent) => ({
    id: `${card.paneKey}\u0000subagent:${subagent.id}`,
    name: subagent.description || subagent.agentType || 'unknown',
    dotState: dashboardCardDotState(subagent.state)
  }))
}

export function patchDashboardSnapshotFromAgentStatus(
  snapshot: DashboardSnapshot,
  event: AgentStatusIpcPayload
): DashboardAgentStatusPatchResult {
  if (event.providerSessionOnly || event.programStatusOnly) {
    return { matched: true, snapshot }
  }
  const index = dashboardCardIndex(snapshot.cards, event.paneKey)
  if (index === -1) {
    return { matched: false, snapshot }
  }
  const card = snapshot.cards[index]
  if (
    event.receivedAt <= (card.statusUpdatedAt ?? 0) ||
    (event.worktreeId !== undefined && event.worktreeId !== card.worktreeId)
  ) {
    return { matched: true, snapshot }
  }

  const stateChanged = event.stateStartedAt > card.stateChangedAt
  const restatesTurn = event.state === 'done' && event.sessionBoundary === true
  // Why ack 0: the event is a live turn and the pop-out holds no acks; the next snapshot has them.
  const unseen =
    stateChanged && !restatesTurn ? isAgentTurnUnacknowledged(0, event.stateStartedAt) : card.unseen
  const dotState = event.state
  const workingMode =
    event.state === 'working' && event.workingMode === 'monitoring' ? event.workingMode : undefined
  const bucket = dashboardBucketForDotState(
    dashboardCardBaseDisplayState({ dotState, workingMode, unseen })
  )
  const nextCard: DashboardCard = {
    ...card,
    ...(event.agentType ? { agentType: event.agentType } : {}),
    ...(event.prompt ? { task: event.prompt, lastUserMessage: event.prompt } : {}),
    ...(event.lastAssistantMessage !== undefined
      ? { lastAgentMessage: event.lastAssistantMessage || undefined }
      : {}),
    ...(event.orchestration?.parentPaneKey
      ? { parentPaneKey: event.orchestration.parentPaneKey }
      : {}),
    bucket,
    dotState,
    verdict: agentVerdictDisplayMark(event) ?? undefined,
    workingMode,
    unseen,
    stateChangedAt: stateChanged ? event.stateStartedAt : card.stateChangedAt,
    statusUpdatedAt: event.receivedAt,
    finishedAt:
      dotState === 'done' && stateChanged && !restatesTurn ? event.stateStartedAt : card.finishedAt,
    askSummary:
      bucket === 'attention'
        ? event.interactivePrompt !== undefined
          ? interactivePromptLabel(
              event.interactivePrompt,
              event.toolName,
              event.agentType ?? card.agentType,
              sayNativeChatApprovalTranslated
            )
          : card.askSummary
        : undefined,
    subagents: patchedSubagents(card, event)
  }
  const cards = replaceDashboardCards(snapshot.cards, new Map([[index, nextCard]]))
  return {
    matched: true,
    snapshot: { ...snapshot, generatedAt: Math.max(snapshot.generatedAt, event.receivedAt), cards }
  }
}
