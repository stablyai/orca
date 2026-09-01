// A typed error for renderer-assisted / background launches when the host
// returns a pre-spawn outcome (no pty id). The plain-Error throw discarded the
// structured failure, so an owner record (automation run, background attempt)
// could only persist the generic message. This carries the whole outcome while
// keeping `.message` the localized string every existing error affordance
// already renders, so no caller that only reads the message changes.

import { agentLaunchOutcomeErrorMessage } from '@/lib/agent-launch-failure-copy'
import type { AgentLaunchFailure } from '../../../shared/agent-launch-contract'
import type { AgentLaunchSpawnOutcome } from '../../../shared/agent-launch-spawn-request'

type NonLaunchedSpawnOutcome = Extract<AgentLaunchSpawnOutcome, { status: 'failed' | 'rejected' }>

export class AgentLaunchSpawnOutcomeError extends Error {
  readonly outcome: NonLaunchedSpawnOutcome

  constructor(outcome: NonLaunchedSpawnOutcome) {
    super(agentLaunchOutcomeErrorMessage(outcome))
    this.name = 'AgentLaunchSpawnOutcomeError'
    this.outcome = outcome
  }
}

/** The structured launch failure carried by a thrown spawn outcome, or null when
 *  the error is untyped or a control-plane rejection — a request error is never a
 *  launch failure and must not persist as one on an owner record. */
export function spawnOutcomeLaunchFailure(error: unknown): AgentLaunchFailure | null {
  return error instanceof AgentLaunchSpawnOutcomeError && error.outcome.status === 'failed'
    ? error.outcome.failure
    : null
}
