import type { HookListenerState } from '../../listener-state'
import { movePaneScopedMapEntries } from '../../pane-scoped-cache-entries'
import { settleRetiredRolloutReads } from './codex-rollout-async-reads'

/** Ends a pane's Codex transcript state (or moves it to `movedTo`), or every pane's, and settles the rollout reads
 *  this retired: the old key's, and on a move the destination's, whose state the move replaced. */
export function retireCodexPaneTranscripts(
  state: HookListenerState,
  paneKey?: string,
  movedTo?: string
): void {
  if (paneKey !== undefined && movedTo !== undefined) {
    movePaneScopedMapEntries(state.codexSubagentRosterByPaneKey, paneKey, movedTo)
    movePaneScopedMapEntries(state.codexSubagentTranscriptByPaneKey, paneKey, movedTo)
    settleRetiredRolloutReads(movedTo)
  } else if (paneKey === undefined) {
    state.codexSubagentRosterByPaneKey.clear()
    state.codexSubagentTranscriptByPaneKey.clear()
  } else {
    state.codexSubagentRosterByPaneKey.delete(paneKey)
    state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  }
  settleRetiredRolloutReads(paneKey)
}

/** Drops a lost Codex owner's children, lead and questions; a replacement process may reuse the pane. */
export function discardCodexPaneOwner(state: HookListenerState, paneKey: string): void {
  state.codexSubagentRosterByPaneKey.delete(paneKey)
  state.codexLeadStateByPaneKey.delete(paneKey)
  state.codexAsyncQuestionsByPaneKey.delete(paneKey)
  settleRetiredRolloutReads(paneKey)
}
