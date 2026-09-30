import type { AgentMainAgentStatus, AgentWorkingMode } from '../../agent-status-types'
import { continueMainAgentStatus, mainAgentTurnInterrupted } from '../../agent-lead-status-fold'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import {
  claudeWaitIsChildOwned,
  type ClaudeAnnouncedCalls,
  type ClaudeApprovalCard,
  type ClaudeApprovalRecord
} from './claude-approval-ledger'
import {
  claudeMainAgentStatusForPayload,
  resolveClaudePaneStatus,
  setClaudeMainAgentTurnState
} from './claude-roster-state'

/** Re-state an outstanding wait over new activity. When only children are owed answers the main
 *  agent is not blocked, so its own progress is recorded behind the wait: restart seeds the main
 *  agent from it, and a stale `done` would let the children's drain settle a row it still works. */
export function holdClaudeWait(
  state: HookListenerState,
  paneKey: string,
  lead: ClaudeLeadTurnState,
  approvals: readonly ClaudeApprovalRecord[],
  announcedCalls: ClaudeAnnouncedCalls | undefined,
  mainAgentProgress: Pick<ClaudeLeadTurnState, 'state' | 'outcome' | 'turnCompletedAt'>
): void {
  const { announcedCalls: _announced, stateBeforeWait: stash, ...record } = lead
  const behind = claudeWaitIsChildOwned(approvals)
    ? {
        state: mainAgentProgress.state,
        ...(mainAgentProgress.outcome ? { outcome: mainAgentProgress.outcome } : {}),
        stateStartedAt: continueMainAgentStatus(stash, mainAgentProgress, Date.now())
          .stateStartedAt,
        ...(mainAgentProgress.turnCompletedAt !== undefined
          ? { turnCompletedAt: mainAgentProgress.turnCompletedAt }
          : {})
      }
    : stash
  setClaudeMainAgentTurnState(state, paneKey, {
    ...record,
    approvals,
    ...(announcedCalls ? { announcedCalls } : {}),
    ...(behind ? { stateBeforeWait: behind } : {})
  })
}

/** Keep what a child's tool event changed on the lead record, since the child path returns before
 *  the main one stores it: a prompt its completion settled, and the id its call announced — even
 *  with nothing outstanding, so the prompt it raises next adopts that id as the main agent's does. */
export function recordClaudeChildToolCall(
  state: HookListenerState,
  paneKey: string,
  lead: ClaudeLeadTurnState,
  approvals: readonly ClaudeApprovalRecord[],
  announcedCalls: ClaudeAnnouncedCalls | undefined
): void {
  if (
    approvals.length === (lead.approvals?.length ?? 0) &&
    announcedCalls === lead.announcedCalls
  ) {
    return
  }
  const { approvals: _settled, ...record } = lead
  setClaudeMainAgentTurnState(state, paneKey, {
    ...record,
    ...(approvals.length > 0 ? { approvals } : {}),
    ...(announcedCalls ? { announcedCalls } : {})
  })
}

/** Clear an AskUserQuestion wait after the answer is typed (answering emits no hook event; the caller infers it from the submit keystroke). Restores the stashed pre-wait lead state or 'working', drops the cached card, and returns the pane state to emit (gated up to 'working' while children run). With another prompt still outstanding, releases only the question and returns that prompt's card. */
export function clearClaudeAnsweredQuestionWait(
  state: HookListenerState,
  paneKey: string
): Pick<ClaudeLeadTurnState, 'state' | 'turnCompletedAt'> & {
  interrupted?: true
  workingMode?: AgentWorkingMode
  mainAgent?: AgentMainAgentStatus
  /** Present while another prompt is still outstanding: the card it shows. */
  card?: ClaudeApprovalCard
} {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const approvals = lead?.state === 'waiting' ? (lead.approvals ?? []) : []
  const answered = approvals.at(-1)
  const previousTool = state.lastToolByPaneKey.get(paneKey)
  state.lastToolByPaneKey.set(
    paneKey,
    previousTool?.lastAssistantMessage
      ? {
          lastAssistantMessage: previousTool.lastAssistantMessage,
          lastAssistantMessageIsToolOutput: previousTool.lastAssistantMessageIsToolOutput
        }
      : {}
  )
  if (lead && answered?.settledBy === 'any-tool-event' && approvals.length > 1) {
    // Why: the typed answer settles only the question on screen (the card is the newest prompt's);
    // a sibling's or child's prompt raised beside it is still live.
    const remaining = approvals.slice(0, -1)
    const held = setClaudeMainAgentTurnState(state, paneKey, {
      ...lead,
      approvals: remaining,
      ...(answered.agentId === undefined
        ? { stateBeforeWait: { state: 'working' as const, stateStartedAt: Date.now() } }
        : {})
    })
    const resolved = resolveClaudePaneStatus(state, paneKey, held)
    const publishedMainAgent = claudeMainAgentStatusForPayload(held)
    return {
      state: resolved.stateName,
      ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
      ...(publishedMainAgent ? { mainAgent: publishedMainAgent } : {}),
      card: remaining.at(-1)?.card ?? {}
    }
  }
  const stash =
    lead?.state === 'waiting'
      ? (lead.stateBeforeWait ?? { state: 'working' as const })
      : { state: 'working' as const }
  const restored = setClaudeMainAgentTurnState(state, paneKey, {
    ...stash,
    ...(lead?.announcedCalls ? { announcedCalls: lead.announcedCalls } : {})
  })
  const publishedMainAgent = claudeMainAgentStatusForPayload(restored)
  const resolved = resolveClaudePaneStatus(state, paneKey, restored)
  return {
    state: resolved.stateName,
    ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
    ...(mainAgentTurnInterrupted(restored) ? { interrupted: true as const } : {}),
    ...(restored.turnCompletedAt !== undefined
      ? { turnCompletedAt: restored.turnCompletedAt }
      : {}),
    ...(publishedMainAgent ? { mainAgent: publishedMainAgent } : {})
  }
}
