import { isAgentSessionThreadGoalFrame } from '../../../../shared/agent-session-thread-goal'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** The goal banner shows goal state, so its transitions leave the transcript. The
 *  journal keeps them; only this view omits them. */
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
