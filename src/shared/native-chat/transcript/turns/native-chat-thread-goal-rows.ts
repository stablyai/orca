import {
  AGENT_SESSION_THREAD_GOAL_PRESENTATION,
  isAgentSessionThreadGoalFrame
} from '../../../agent-session/thread-goals/agent-session-thread-goal'
import type { NativeChatMessage } from '../../native-chat-types'
import { AGENT_SESSION_GOAL_CHECK_PRESENTATION } from '../../../agent-session/thread-goals/agent-session-goal-check-display'

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
      (block) =>
        block.type === 'text' &&
        (block.presentation === AGENT_SESSION_THREAD_GOAL_PRESENTATION ||
          block.presentation === AGENT_SESSION_GOAL_CHECK_PRESENTATION ||
          isAgentSessionThreadGoalFrame(block.providerFrame))
    )
  )
}
