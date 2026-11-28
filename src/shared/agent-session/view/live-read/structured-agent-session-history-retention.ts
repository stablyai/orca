import type { StructuredAgentSessionAction, StructuredAgentSessionState } from './structured-agent-session-reducer'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  mergeSubmissions,
  ownItemCount,
  trimRetainedItems
} from '../structured-agent-session-item-retention'
import { mergeItems } from '../structured-agent-session-history-state'
import { foldStructuredAgentSubagentRosterPage } from '../structured-agent-session-subagent-roster'
import { readAgentJournalTurn } from '../../lifecycle/records/agent-session-turn-record'
import { agentSessionHasOlderTranscript } from '../../conversation-context/agent-session-context-clear'

export function trimStructuredAgentSessionHistory(
  state: StructuredAgentSessionState
): StructuredAgentSessionState {
  const items = trimRetainedItems(state.items, MAX_RETAINED_OWN_ITEMS, MAX_RETAINED_ITEMS)
  if (
    items === state.items &&
    state.retainedOwnItemLimit === MAX_RETAINED_OWN_ITEMS &&
    state.retainedItemCap === MAX_RETAINED_ITEMS
  ) {
    return state
  }
  const lostTurnRow = state.items
    .slice(0, state.items.length - items.length)
    .some((item) => readAgentJournalTurn(item.body) !== null)
  return {
    ...state,
    items,
    retainedOwnItemLimit: MAX_RETAINED_OWN_ITEMS,
    retainedItemCap: MAX_RETAINED_ITEMS,
    submissions: mergeSubmissions(state.submissions, [], items),
    hasOlder: agentSessionHasOlderTranscript(items, state.hasOlder || items !== state.items),
    ...(lostTurnRow ? { unloadedTurnRevisions: (state.unloadedTurnRevisions ?? 0) + 1 } : {})
  }
}

export function mergeOlderStructuredAgentSessionPage(
  state: StructuredAgentSessionState,
  action: Extract<StructuredAgentSessionAction, { type: 'older-page' }>
): StructuredAgentSessionState {
  const requested = action.requestedCursor
  if (state.epoch !== requested.epoch || action.page.epoch !== requested.epoch) {
    return state
  }
  const head = state.items[0]
  // Head trim overtook the requested anchor; merging would leave a hole. Caller must retry from the new head.
  if (head && head.sequence > requested.sequence) {
    return state
  }
  const items = mergeItems(state.items, action.page.items, action.page.removedItemIds)
  return {
    ...state,
    items,
    retainedOwnItemLimit: Math.max(state.retainedOwnItemLimit, ownItemCount(items)),
    retainedItemCap: Math.max(state.retainedItemCap, items.length),
    subagentRoster: foldStructuredAgentSubagentRosterPage(state.subagentRoster, action.page),
    submissions: mergeSubmissions(state.submissions, action.page.submissions, items),
    hasOlder: agentSessionHasOlderTranscript(items, action.page.hasOlder),
    ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
  }
}
