import { isAskUserQuestionTool } from './agent-question-answered-intent'
import { isToolCallBlock, isToolResultBlock, type NativeChatBlock } from './native-chat-types'

/** Call ordinals whose question tool came back errored — the user declined it. */
export function declinedQuestionCallOrdinals(blocks: readonly NativeChatBlock[]): Set<number> {
  const declined = new Set<number>()
  const questionOrdinals: number[] = []
  let callOrdinal = -1
  let resultOrdinal = 0
  for (const block of blocks) {
    if (isToolCallBlock(block)) {
      callOrdinal += 1
      questionOrdinals.push(isAskUserQuestionTool(block.name) ? callOrdinal : -1)
      continue
    }
    if (!isToolResultBlock(block)) {
      continue
    }
    const owner = questionOrdinals[resultOrdinal]
    resultOrdinal += 1
    if (owner !== undefined && owner >= 0 && block.isError === true) {
      declined.add(owner)
    }
  }
  return declined
}
