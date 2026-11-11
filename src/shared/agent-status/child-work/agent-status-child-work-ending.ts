// Settled history gains precision: unknown may become definite. Only the child's own ending can replace a definite Stop acknowledgement (frames may arrive out of order); omitted outcome means unknown.

import type {
  AgentChildWorkMembership,
  AgentChildWorkOutcome,
  AgentChildWorkOutcomeBasis,
  AgentChildWorkRecord,
  AgentChildWorkState
} from './agent-status-child-work'

type Ending = { outcome?: AgentChildWorkOutcome; outcomeBasis?: AgentChildWorkOutcomeBasis }
/** Both said: `undefined` is "no ending", as every admission fact reads it. */
type KeptEnding = {
  outcome: AgentChildWorkOutcome | undefined
  outcomeBasis: AgentChildWorkOutcomeBasis | undefined
}

/** Whether an observation of a settled child contradicts what it settled with. */
export function agentChildWorkEndingConflicts(
  child: AgentChildWorkRecord,
  request: Ending & { membership: AgentChildWorkMembership; state: AgentChildWorkState }
): boolean {
  const requested = request.outcome ?? 'unknown'
  const reportedOverProvisional =
    child.outcomeBasis === 'stop-acknowledged' && request.outcomeBasis === undefined
  return (
    request.membership !== 'settled' ||
    request.state !== child.state ||
    (requested !== 'unknown' &&
      child.outcome !== 'unknown' &&
      requested !== child.outcome &&
      !reportedOverProvisional)
  )
}

/** The ending a record keeps. `run` is the stored record only when the observation continues its
 *  invocation. */
export function mergedAgentChildWorkEnding(
  said: Ending,
  run: (Ending & { membership?: string }) | undefined
): KeptEnding {
  const saidDefinite = said.outcome !== undefined && said.outcome !== 'unknown'
  // The child's own definite ending stands against an acknowledged Stop that says the same.
  const reportedStands =
    run?.membership === 'settled' &&
    run.outcome !== undefined &&
    run.outcome !== 'unknown' &&
    run.outcomeBasis === undefined
  return {
    // Refine-only: an `unknown` ending claims nothing, so a definite one stands.
    outcome: saidDefinite ? said.outcome : (run?.outcome ?? said.outcome),
    outcomeBasis: saidDefinite && !reportedStands ? said.outcomeBasis : run?.outcomeBasis
  }
}
