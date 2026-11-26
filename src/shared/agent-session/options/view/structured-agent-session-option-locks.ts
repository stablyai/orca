import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import { modelNamesServingAgent } from '../model-catalog/agent-model-catalog-ownership'
import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'

/** Once an agent holds the conversation, a chat whose model names its agent stays with it. */
function servingAgentLocked(state: StructuredAgentSessionOptionState): boolean {
  return state.holdsProviderConversation === true && modelNamesServingAgent(state.record.agent)
}

/** The picker shows the serving agent read-only once it holds the conversation, as the host does. */
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

/** Options this chat's state holds still: a restricted Fast mode, or the agent holding the chat. */
export function optionHeldByChat(state: StructuredAgentSessionOptionState, id: string): boolean {
  return (
    (id === 'fastMode' && state.fastModeRestricted === true) ||
    (id === 'model' && servingAgentLocked(state))
  )
}
