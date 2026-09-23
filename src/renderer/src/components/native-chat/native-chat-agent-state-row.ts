// What the transcript tail says about the agent right now.
//
// One decision, two presentations. The turn-activity line and the waiting line
// are different rows, but which of them a pane draws is decided here so the two
// lanes cannot answer "is the agent working" and "is the agent waiting on me"
// from different facts.

import type { AgentStatusState } from '../../../../shared/agent-status-types'

export type NativeChatAgentStateRow = 'working' | 'waiting-for-user'

export function resolveNativeChatAgentStateRow(args: {
  /** Reconciled turn truth: hook state merged with the transcript's own turn
   *  boundaries, minus local Stop suppression. Stays the sole working authority
   *  so a stopped turn cannot be revived by a hook row that has not caught up. */
  isWorking: boolean
  /** Freshness-gated coarse hook state for the pane; null when none is fresh. */
  agentState?: AgentStatusState | null
}): NativeChatAgentStateRow | null {
  if (args.isWorking) {
    return 'working'
  }
  // `blocked` and `waiting` are one fact to a reader — the agent stopped and
  // needs them — and the repo already treats them as one (synthetic-agent-title
  // maps both to the permission label). `done` draws nothing: the finished turn
  // is already on screen.
  return args.agentState === 'blocked' || args.agentState === 'waiting' ? 'waiting-for-user' : null
}
