import { normalizeNativeChatTaskList } from '../../../../shared/native-chat-task-list'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const projectedFrames = new WeakMap<NativeChatMessage, NativeChatMessage>()

/** Project after tool folding so a notification never takes another call's result. */
export function projectNativeChatTaskListFrames(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return messages.map((message) => {
    const cached = projectedFrames.get(message)
    if (cached) {
      return cached
    }
    const block = message.blocks.length === 1 ? message.blocks[0] : undefined
    const frame = block?.type === 'text' ? block.providerFrame : undefined
    if (
      message.role !== 'system' ||
      frame?.provider !== 'codex' ||
      frame.kind !== 'notification:turn/plan/updated' ||
      frame.payload.truncated ||
      !normalizeNativeChatTaskList('update_plan', frame.payload.head)
    ) {
      return message
    }
    const projected: NativeChatMessage = {
      ...message,
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'update_plan', input: frame.payload.head, state: 'completed' }
      ]
    }
    projectedFrames.set(message, projected)
    return projected
  })
}
