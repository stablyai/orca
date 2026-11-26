import { normalizeNativeChatTaskList } from './native-chat-task-list'
import type { NativeChatMessage } from '../../native-chat-types'

const projectedFrames = new WeakMap<NativeChatMessage, NativeChatMessage>()

/** Project after tool folding so a notification never takes another call's result. */
export function projectNativeChatTaskListFrames(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  return messages.map(projectNativeChatTaskListFrame)
}

export function projectNativeChatTaskListFrame(message: NativeChatMessage): NativeChatMessage {
  if (message.role !== 'system') {
    return message
  }
  const cached = projectedFrames.get(message)
  if (cached) {
    return cached
  }
  const block = message.blocks.length === 1 ? message.blocks[0] : undefined
  const frame = block?.type === 'text' ? block.providerFrame : undefined
  if (
    frame?.provider !== 'codex' ||
    frame.kind !== 'notification:turn/plan/updated' ||
    frame.payload.truncated ||
    !normalizeNativeChatTaskList('update_plan', frame.payload.head)
  ) {
    projectedFrames.set(message, message)
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
}
