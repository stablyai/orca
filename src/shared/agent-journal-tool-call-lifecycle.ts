// A tool call's lifecycle as readers show it. A call cut short keeps `state: 'failed'`, which every
// build reads, and carries the finer fact beside it: persisted rows outlive the build that wrote
// them, and a new state value would read as a success to a build that only knows these three.

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

/** A call that stopped because its turn or session was proven to end, or the provider cancelled
 *  it: it neither finished nor failed on its own. */
export function interruptedAgentJournalToolCall(
  call: AgentJournalToolCallItem
): AgentJournalToolCallItem {
  return { ...call, state: 'failed', endedAs: 'interrupted' }
}

/** What a call still running when its turn or session ended becomes. Only a proven interruption
 *  cuts it short: a turn the provider completed around it, or an end the host could not verify,
 *  proves none, so it reads failed as it always has. An unverified end is kept beside that, so a
 *  proof written later can still find the call. */
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
