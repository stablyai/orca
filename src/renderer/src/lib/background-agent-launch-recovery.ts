// Maps a generic background agent-launch attempt (WorktreeMeta.backgroundAgentLaunches)
// to the shared recovery-card action model, so the sidebar unattended-failure card
// renders identically to the interactive worktree and session surfaces (per the
// RetryBackgroundAgentLaunchRequest contract note). Pure and store/IPC-free.

import {
  resolveAgentLaunchRecoveryCard,
  type AgentLaunchRecoveryCardModel,
  type AgentLaunchRecoveryLiveness
} from '@/lib/agent-launch-recovery-card'
import type { BackgroundAgentLaunchAttempt } from '../../../shared/background-agent-launch'
import type { PersistedAgentLaunchFailure } from '../../../shared/agent-launch-contract'

export type BackgroundAgentLaunchRecovery = {
  failure: PersistedAgentLaunchFailure
  model: AgentLaunchRecoveryCardModel
}

/** Resolve the recovery-card inputs for a background attempt, or null when nothing
 *  should surface. A `failed` attempt has no contending terminal, so its liveness
 *  is `idle` and the code-based recovery row applies. A `pending` attempt stranded
 *  in `launch_state_unknown` (state `pending` + a failure — the coexistence rule)
 *  may still have a token-matched terminal alive, so its liveness is `unknown` and
 *  the card offers Reconnect + Forget instead of a duplicate-risking Retry. A
 *  `launched` or `forgotten` attempt surfaces no card. */
export function resolveBackgroundAgentLaunchRecovery(
  attempt: BackgroundAgentLaunchAttempt
): BackgroundAgentLaunchRecovery | null {
  if (attempt.state === 'launched' || attempt.state === 'forgotten') {
    return null
  }
  if (!attempt.failure) {
    return null
  }
  const liveness: AgentLaunchRecoveryLiveness = attempt.state === 'pending' ? 'unknown' : 'idle'
  return {
    failure: attempt.failure,
    model: resolveAgentLaunchRecoveryCard(attempt.failure, { liveness })
  }
}
