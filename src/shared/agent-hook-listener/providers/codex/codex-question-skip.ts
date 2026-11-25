import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { pendingCodexAsyncQuestion, skipCodexAsyncQuestion } from './codex-async-questions'
import { buildCodexStatusPayload } from './codex-events'
import { resolveCodexPaneStatus, setCodexMainAgentTurnState } from './codex-state'

/** Restate a local Codex row after the user skips its focused async question; null when none was
 *  open. Codex keeps working behind the question, so only the open question held the row waiting. */
export function codexRowAfterQuestionSkip(
  state: HookListenerState,
  row: AgentHookEventPayload
): AgentHookEventPayload | null {
  const lead = state.codexLeadStateByPaneKey.get(row.paneKey)
  // A relayed pane's questions are tracked on its execution host, out of reach here.
  if (row.connectionId || !lead || !skipCodexAsyncQuestion(state, row.paneKey)) {
    return null
  }
  const record = pendingCodexAsyncQuestion(state, row.paneKey)
    ? lead
    : setCodexMainAgentTurnState(state, row.paneKey, { state: 'working', model: lead.model })
  const payload = buildCodexStatusPayload(
    state,
    undefined,
    '',
    row.paneKey,
    {},
    {
      ...resolveCodexPaneStatus(state, row.paneKey, record),
      updateLead: false
    }
  )
  // Carry only the row's identity, as Orca's other inferred restatements do.
  return (
    payload && {
      paneKey: row.paneKey,
      tabId: row.tabId,
      worktreeId: row.worktreeId,
      connectionId: row.connectionId,
      providerSession: row.providerSession,
      launchToken: row.launchToken,
      hostTurnRevision: row.hostTurnRevision,
      source: row.source,
      payload
    }
  )
}
