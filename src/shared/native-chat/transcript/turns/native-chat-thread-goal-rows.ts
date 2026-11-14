import { isAgentSessionThreadGoalFrame } from '../../../agent-session/agent-session-thread-goal'
import type { NativeChatMessage } from '../../native-chat-types'

/** Show goal transitions in the banner only; retain them in the journal. */
export function omitNativeChatThreadGoalRows(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return messages.filter((message) => !isNativeChatThreadGoalRow(message))
}

export function isNativeChatThreadGoalRow(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) => block.type === 'text' && isAgentSessionThreadGoalFrame(block.providerFrame)
    )
  )
}
