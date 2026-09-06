import type { RoomAgentActivity } from '../../../../shared/rooms'
import type {
  StreamingTextFrameQueue,
  StreamingTextFrameTarget
} from '../native-chat/streaming-text-frame-queue'
import { visibleRoomReplyText } from '../native-chat/native-chat-room-transport'

export function activityWithVisibleRoomText(activity: RoomAgentActivity): RoomAgentActivity {
  return {
    ...activity,
    messages: activity.messages.map((message) =>
      message.role === 'assistant'
        ? {
            ...message,
            blocks: message.blocks.map((block) =>
              block.type === 'text' ? { ...block, text: visibleRoomReplyText(block.text) } : block
            )
          }
        : message
    )
  }
}

export function activityWithEmptyText(activity: RoomAgentActivity): RoomAgentActivity {
  return {
    ...activity,
    messages: activity.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'text' ? { ...block, text: '' } : block
      )
    }))
  }
}

export function activityWithoutFinalText(activity: RoomAgentActivity): RoomAgentActivity {
  return {
    ...activity,
    messages: activity.messages.map((message) =>
      message.assistantPhase === 'final'
        ? {
            ...message,
            blocks: message.blocks.map((block) =>
              block.type === 'text' ? { ...block, text: '' } : block
            )
          }
        : message
    )
  }
}

export function projectActivityText(
  previous: RoomAgentActivity,
  visual: RoomAgentActivity,
  next: RoomAgentActivity,
  queue: StreamingTextFrameQueue
): RoomAgentActivity {
  return {
    ...next,
    messages: next.messages.map((message) => {
      const oldMessage = previous.messages.find((candidate) => candidate.id === message.id)
      const visualMessage = visual.messages.find((candidate) => candidate.id === message.id)
      return {
        ...message,
        blocks: message.blocks.map((block, blockIndex) => {
          if (block.type !== 'text') {
            return block
          }
          const oldBlock = oldMessage?.blocks[blockIndex]
          const visibleBlock = visualMessage?.blocks[blockIndex]
          const oldText = oldBlock?.type === 'text' ? oldBlock.text : ''
          const visibleText = visibleBlock?.type === 'text' ? visibleBlock.text : ''
          if (block.text.startsWith(oldText) && oldText.startsWith(visibleText)) {
            return { ...block, text: visibleText }
          }
          queue.discard(frameTarget(next.participantId, message.id, blockIndex))
          return block
        })
      }
    })
  }
}

export function appendActivityDeltas(
  activity: RoomAgentActivity,
  deltas: (StreamingTextFrameTarget & { text: string })[]
): RoomAgentActivity {
  let messages = activity.messages
  for (const delta of deltas) {
    messages = messages.map((message) => {
      if (message.id !== delta.messageId) {
        return message
      }
      const block = message.blocks[delta.blockIndex]
      if (block?.type !== 'text') {
        return message
      }
      const blocks = [...message.blocks]
      blocks[delta.blockIndex] = { ...block, text: block.text + delta.text }
      return { ...message, blocks }
    })
  }
  return { ...activity, messages }
}

export function frameTarget(
  participantId: string,
  messageId: string,
  blockIndex: number
): StreamingTextFrameTarget {
  return { scopeId: participantId, messageId, blockIndex }
}
