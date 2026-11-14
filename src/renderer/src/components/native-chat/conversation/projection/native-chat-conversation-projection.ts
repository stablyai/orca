import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { projectNativeChatTaskListFrame } from '../../../../../../shared/native-chat/input/task-lists/native-chat-task-list-frames'
import { isNativeChatThreadGoalRow } from '../../../../../../shared/native-chat/transcript/turns/native-chat-thread-goal-rows'

/** These independent transforms consume folded rows; unchanged rows need no block inspection. */
export function createNativeChatConversationProjection() {
  const rows = new WeakMap<NativeChatMessage, { message: NativeChatMessage; goal: boolean }>()
  let previous: NativeChatMessage[] = []
  return (messages: readonly NativeChatMessage[], hideGoals: boolean): NativeChatMessage[] => {
    const next: NativeChatMessage[] = []
    let unchanged = true
    for (const source of messages) {
      let message = source
      let goal = false
      if (source.role === 'system') {
        let row = rows.get(source)
        if (!row) {
          const projected = projectNativeChatTaskListFrame(source)
          row = { message: projected, goal: isNativeChatThreadGoalRow(projected) }
          rows.set(source, row)
        }
        message = row.message
        goal = row.goal
      }
      if (!hideGoals || !goal) {
        unchanged &&= previous[next.length] === message
        next.push(message)
      }
    }
    if (unchanged && previous.length === next.length) {
      return previous
    }
    previous = next
    return next
  }
}
