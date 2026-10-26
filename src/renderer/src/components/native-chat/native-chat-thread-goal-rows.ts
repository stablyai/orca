import { isAgentSessionThreadGoalFrame } from '../../../../shared/agent-session-thread-goal'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Show goal transitions in the banner only; retain them in the journal. */
export function omitNativeChatThreadGoalRows(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return messages.filter(
    (message) =>
      message.role !== 'system' ||
      !message.blocks.some(
        (block) => block.type === 'text' && isAgentSessionThreadGoalFrame(block.providerFrame)
      )
  )
}
