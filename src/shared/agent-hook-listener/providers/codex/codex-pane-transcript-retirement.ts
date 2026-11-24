import type { HookListenerState } from '../../listener-state'
import { settleRetiredRolloutReads } from './codex-rollout-async-reads'

/** Ends a pane's Codex transcript state, or every pane's, and settles the rollout reads queued for it. */
export function retireCodexPaneTranscripts(state: HookListenerState, paneKey?: string): void {
  if (paneKey === undefined) {
    state.codexSubagentRosterByPaneKey.clear()
    state.codexSubagentTranscriptByPaneKey.clear()
  } else {
    state.codexSubagentRosterByPaneKey.delete(paneKey)
    state.codexSubagentTranscriptByPaneKey.delete(paneKey)
  }
  settleRetiredRolloutReads(paneKey)
}
