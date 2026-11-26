import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { projectNativeChatTaskListFrame } from '../../../../../../shared/native-chat/input/task-lists/native-chat-task-list-frames'
import { NativeChatGoalRows } from '../../../../../../shared/native-chat/transcript/turns/native-chat-thread-goal-rows'
import { nativeChatRowRendersProse } from '../../../../../../shared/native-chat/transcript/folding/native-chat-trailing-run'
import { isNativeChatContextClear } from '../../../../../../shared/agent-session/conversation-context/agent-session-context-clear'
import {
  noteRevisedInPlace,
  positionsRevisedFrom
} from '../../../../../../shared/agent-session/view/revised-in-place-lists'

type Projected = {
  input: readonly NativeChatMessage[]
  hideGoals: boolean
  output: NativeChatMessage[]
  /** Where each input row is in the output, or -1 when it was hidden or folded into another row. */
  outputAt: readonly number[]
}

/** These independent transforms consume folded rows; unchanged rows need no block inspection. */
export function createNativeChatConversationProjection() {
  const rows = new WeakMap<NativeChatMessage, NativeChatMessage>()
  let previous: Projected | null = null
  return (messages: readonly NativeChatMessage[], hideGoals: boolean): NativeChatMessage[] => {
    const at =
      previous?.hideGoals === hideGoals ? positionsRevisedFrom(messages, previous.input) : undefined
    const revised = at && previous && reviseInPlace(previous, messages, at)
    if (revised) {
      previous = { ...previous!, input: messages, output: revised }
      return revised
    }
    const goals = new NativeChatGoalRows()
    const next = goals.messages
    const outputAt: number[] = []
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
      outputAt.push(next.at(-1) === message && message === source ? next.length - 1 : -1)
    }
    goals.finish()
    const output = previous?.output ?? []
    const unchanged = next.every((message, index) => output[index] === message)
    previous = {
      input: messages,
      hideGoals,
      outputAt,
      output: unchanged && output.length === next.length ? output : next
    }
    return previous.output
  }
}

/** A non-system row whose prose-ness holds places no goal summary or check mark, so it replaces
 *  its own output row; anything else is projected in full. */
function reviseInPlace(
  previous: Projected,
  messages: readonly NativeChatMessage[],
  at: readonly number[]
): NativeChatMessage[] | undefined {
  let output: NativeChatMessage[] | undefined
  const positions: number[] = []
  for (const index of at) {
    const prior = previous.input[index]!
    const message = messages[index]!
    const position = previous.outputAt[index]!
    if (
      prior.role === 'system' ||
      prior.role !== message.role ||
      position < 0 ||
      previous.output[position] !== prior ||
      isNativeChatContextClear(prior) ||
      isNativeChatContextClear(message) ||
      nativeChatRowRendersProse(prior) !== nativeChatRowRendersProse(message)
    ) {
      return undefined
    }
    ;(output ??= previous.output.slice())[position] = message
    positions.push(position)
  }
  if (!output) {
    return previous.output
  }
  noteRevisedInPlace(output, previous.output, positions)
  return output
}
