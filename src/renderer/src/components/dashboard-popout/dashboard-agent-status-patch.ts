import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardCardSubagent,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import { dashboardBucketForDotState } from '../dashboard/dashboard-card-bucket'

export type DashboardAgentStatusPatchResult = {
  matched: boolean
  snapshot: DashboardSnapshot
}

function patchedSubagents(
  card: DashboardCard,
  event: AgentStatusIpcPayload
): DashboardCardSubagent[] | undefined {
  if (event.subagents === undefined) {
    return card.subagents
  }
  return event.subagents.map((subagent) => ({
    id: `${card.paneKey}\u0000subagent:${subagent.id}`,
    name: subagent.description || subagent.agentType || 'unknown',
    dotState: subagent.state
  }))
}

/** Applies an already bounded hook event inside the pop-out renderer. */
export function patchDashboardSnapshotFromAgentStatus(
  snapshot: DashboardSnapshot,
  event: AgentStatusIpcPayload
): DashboardAgentStatusPatchResult {
  if (event.providerSessionOnly) {
    return { matched: true, snapshot }
  }
  const index = snapshot.cards.findIndex((card) => card.paneKey === event.paneKey)
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
  const unseen = stateChanged ? card.startedAt !== 0 : card.unseen
  const dotState = event.state
  const bucket = dashboardBucketForDotState(dashboardCardDisplayState({ dotState, unseen }))
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
    unseen,
    stateChangedAt: stateChanged ? event.stateStartedAt : card.stateChangedAt,
    statusUpdatedAt: event.receivedAt,
    finishedAt: dotState === 'done' && stateChanged ? event.stateStartedAt : card.finishedAt,
    askSummary:
      bucket === 'attention'
        ? event.interactivePrompt !== undefined
          ? event.interactivePrompt || undefined
          : card.askSummary
        : undefined,
    subagents: patchedSubagents(card, event)
  }
  const cards = snapshot.cards.slice()
  cards[index] = nextCard
  return {
    matched: true,
    snapshot: { ...snapshot, generatedAt: Math.max(snapshot.generatedAt, event.receivedAt), cards }
  }
}
