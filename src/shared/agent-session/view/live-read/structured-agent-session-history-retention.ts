import type { StructuredAgentSessionState } from './structured-agent-session-reducer'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  trimRetainedItems
} from '../structured-agent-session-item-retention'
import { readAgentJournalTurn } from '../../lifecycle/records/agent-session-turn-record'
import { agentSessionHasOlderTranscript } from '../../conversation-context/agent-session-context-clear'

import { mergeStructuredAgentSubmissions } from './structured-agent-session-submission-retention'

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
    ...mergeStructuredAgentSubmissions(state, [], items),
    hasOlder: agentSessionHasOlderTranscript(items, state.hasOlder || items !== state.items),
    ...(lostTurnRow ? { unloadedTurnRevisions: (state.unloadedTurnRevisions ?? 0) + 1 } : {})
  }
}
