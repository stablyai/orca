// Persist interrupted calls as failed plus endedAs; older readers would misread a new state as success.

import type {
  AgentJournalToolCallEnding,
  AgentJournalToolCallItem,
  AgentJournalToolCallState,
  AgentJournalTurnLifecycleState
} from './agent-session-journal-types'

export type AgentJournalToolCallLifecycle = AgentJournalToolCallState | 'interrupted'

/** How the turn or session around a still-running call ended. */
export type AgentJournalRunningCallEnd = Exclude<AgentJournalTurnLifecycleState, 'running'>

type ToolCallLifecycleFields = {
  state?: AgentJournalToolCallState
  endedAs?: AgentJournalToolCallEnding
}

/** Undefined when the lane reports no lifecycle, as legacy transcripts do. */
export function agentJournalToolCallLifecycle(
  call: ToolCallLifecycleFields
): AgentJournalToolCallLifecycle | undefined {
  return call.state === 'failed' && call.endedAs === 'interrupted' ? 'interrupted' : call.state
}

/** Proven owner/provider interruption, rather than the call's own failure or completion. */
export function interruptedAgentJournalToolCall(
  call: AgentJournalToolCallItem
): AgentJournalToolCallItem {
  return { ...call, state: 'failed', endedAs: 'interrupted' }
}

/** Only proven interruption changes failed to interrupted; retain unverified owner ends so later proof can find the call. */
export function endedRunningAgentJournalToolCall(
  call: AgentJournalToolCallItem,
  end: AgentJournalRunningCallEnd
): AgentJournalToolCallItem {
  if (end === 'interrupted') {
    return interruptedAgentJournalToolCall(call)
  }
  return end === 'unverifiable'
    ? { ...call, state: 'failed', endedAs: 'unverifiable' }
    : { ...call, state: 'failed' }
}

/** A call an unverified end closed: still waiting on a proof that its owner died. */
export function isUnverifiedEndAgentJournalToolCall(call: ToolCallLifecycleFields): boolean {
  return call.state === 'failed' && call.endedAs === 'unverifiable'
}
