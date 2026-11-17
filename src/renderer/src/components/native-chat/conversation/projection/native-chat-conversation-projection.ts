import {
  streamedTextReplacementIndexes,
  noteStreamedTextRevision
} from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { projectNativeChatTaskListFrame } from '../../../../../../shared/native-chat/input/task-lists/native-chat-task-list-frames'
import { isNativeChatThreadGoalRow } from '../../../../../../shared/native-chat/transcript/turns/native-chat-thread-goal-rows'

/** These independent transforms consume folded rows; unchanged rows need no block inspection. */
export function createNativeChatConversationProjection() {
  const rows = new WeakMap<NativeChatMessage, { message: NativeChatMessage; goal: boolean }>()
  let previous: NativeChatMessage[] = []
  let input: readonly NativeChatMessage[] = []
  let hidden = false
  const at = new Map<string, number>()
  return (messages: readonly NativeChatMessage[], hideGoals: boolean): NativeChatMessage[] => {
    const indexes = hidden === hideGoals ? streamedTextReplacementIndexes(input, messages) : null
    if (indexes !== null) {
      const next = previous.slice()
      const changed: number[] = []
      for (const index of indexes) {
        const source = messages[index]!
        const target = at.get(source.id)
        if (target !== undefined) {
          next[target] = source
          changed.push(target)
        }
      }
      noteStreamedTextRevision(next, previous, changed)
      previous = next
      input = messages
      return next
    }
    input = messages
    hidden = hideGoals
    at.clear()
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
        at.set(source.id, next.length)
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
