import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import { modelNamesServingAgent } from '../model-catalog/agent-model-catalog-ownership'
import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'

/** A started chat whose model names its agent stays with that agent. */
function servingAgentLocked(state: StructuredAgentSessionOptionState): boolean {
  return state.sessionNeverStarted === false && modelNamesServingAgent(state.record.agent)
}

/** The picker shows the serving agent read-only once the chat has started. */
export function withServingAgentLock(
  state: StructuredAgentSessionOptionState,
  descriptors: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return descriptors.map((descriptor) =>
    descriptor.id === 'model' && servingAgentLocked(state)
      ? { ...descriptor, settable: false, disabledReason: 'set-when-session-starts' }
      : descriptor
  )
}

/** Options this chat's state holds still: a restricted Fast mode, or a started chat's serving agent. */
export function optionHeldByChat(state: StructuredAgentSessionOptionState, id: string): boolean {
  return (
    (id === 'fastMode' && state.fastModeRestricted === true) ||
    (id === 'model' && servingAgentLocked(state))
  )
}
