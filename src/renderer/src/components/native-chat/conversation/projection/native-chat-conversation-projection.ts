import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { projectNativeChatTaskListFrame } from '../../../../../../shared/native-chat/input/task-lists/native-chat-task-list-frames'
import { NativeChatGoalRows } from '../../../../../../shared/native-chat/transcript/turns/native-chat-thread-goal-rows'

/** These independent transforms consume folded rows; unchanged rows need no block inspection. */
export function createNativeChatConversationProjection() {
  const rows = new WeakMap<NativeChatMessage, NativeChatMessage>()
  let previous: NativeChatMessage[] = []
  return (messages: readonly NativeChatMessage[], hideGoals: boolean): NativeChatMessage[] => {
    const goals = new NativeChatGoalRows()
    const next = goals.messages
    for (const source of messages) {
      let message = source
      if (source.role === 'system') {
        let row = rows.get(source)
        if (!row) {
          const projected = projectNativeChatTaskListFrame(source)
          row = projected
          rows.set(source, row)
        }
        message = row
      }
      goals.append(message, hideGoals)
    }
    goals.finish()
    const unchanged = next.every((message, index) => previous[index] === message)
    if (unchanged && previous.length === next.length) {
      return previous
    }
    previous = next
    return next
  }
}
