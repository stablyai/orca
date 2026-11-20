import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../agent-status/transport/agent-status-legacy-adapter'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { admitLegacyAgentStatus } from './listener-legacy-agent-status'

/** Test harnesses seed the same compatibility region without exposing a mutable Map. */
export function seedLegacyAgentStatusForTests(
  state: HookListenerState,
  entry: AgentHookEventPayload
): void {
  if (
    !admitLegacyAgentStatus(
      state,
      'main-status-update',
      entry,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  ) {
    throw new Error('Test legacy agent-status seed was refused')
  }
}
