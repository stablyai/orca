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

export type DashboardAgentStatusPatchResult = {
  matched: boolean
  snapshot: DashboardSnapshot
}

/** Live states whose `statusUpdatedAt` drives the stale-status refresh. */
export function dashboardCardTracksFreshness(card: Pick<DashboardCard, 'dotState'>): boolean {
  return card.dotState === 'working' || card.dotState === 'blocked' || card.dotState === 'waiting'
}

// Why: a patch replaces one slot, so the next cards array reuses the same pane index.
const paneIndexByCards = new WeakMap<readonly DashboardCard[], Map<string, number>>()

function paneIndex(cards: readonly DashboardCard[]): Map<string, number> {
  let index = paneIndexByCards.get(cards)
  if (!index) {
    index = new Map()
    for (let i = 0; i < cards.length; i++) {
      if (!index.has(cards[i].paneKey)) {
        index.set(cards[i].paneKey, i)
      }
    }
    paneIndexByCards.set(cards, index)
  }
  return index
}

function sameSubagents(
  a: DashboardCardSubagent[] | undefined,
  b: DashboardCardSubagent[] | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  return a.every(
    (subagent, i) =>
      subagent.id === b[i].id && subagent.name === b[i].name && subagent.dotState === b[i].dotState
  )
}

/** A restatement of a card off the freshness clock changes nothing the pop-out shows. */
function restatesCard(card: DashboardCard, next: DashboardCard): boolean {
  return (
    !dashboardCardTracksFreshness(next) &&
    next.agentType === card.agentType &&
    next.task === card.task &&
    next.lastUserMessage === card.lastUserMessage &&
    next.lastAgentMessage === card.lastAgentMessage &&
    next.parentPaneKey === card.parentPaneKey &&
    next.bucket === card.bucket &&
    next.dotState === card.dotState &&
    next.verdict === card.verdict &&
    next.workingMode === card.workingMode &&
    next.unseen === card.unseen &&
    next.stateChangedAt === card.stateChangedAt &&
    next.finishedAt === card.finishedAt &&
    next.askSummary === card.askSummary &&
    sameSubagents(next.subagents, card.subagents)
  )
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
  const panes = paneIndex(snapshot.cards)
  const index = panes.get(event.paneKey)
  if (index === undefined) {
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
  if (restatesCard(card, nextCard)) {
    return { matched: true, snapshot }
  }
  const cards = snapshot.cards.slice()
  cards[index] = nextCard
  paneIndexByCards.set(cards, panes)
  return {
    matched: true,
    snapshot: { ...snapshot, generatedAt: Math.max(snapshot.generatedAt, event.receivedAt), cards }
  }
}
