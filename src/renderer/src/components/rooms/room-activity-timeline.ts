import type {
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import { roomActivityKindFromTool } from '../../../../shared/room-activity'
import type { RoomActivityKind, RoomCompletedActivity } from '../../../../shared/rooms'

export type RoomActivityToolStep = {
  id: string
  call: NativeChatToolCallBlock
  result: NativeChatToolResultBlock | null
  timestamp: number | null
  kind: RoomActivityKind
}

export type RoomActivitySection =
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'tools'; id: string; tools: RoomActivityToolStep[] }

export function buildRoomActivitySections(messages: NativeChatMessage[]): RoomActivitySection[] {
  const sections: RoomActivitySection[] = []
  const pendingResults: RoomActivityToolStep[] = []
  const pendingById = new Map<string, RoomActivityToolStep>()
  let resultCursor = 0

  for (const message of [...messages].sort(compareMessages)) {
    for (const [blockIndex, block] of message.blocks.entries()) {
      if (block.type === 'text') {
        if (message.role !== 'assistant' && message.role !== 'reasoning') {
          continue
        }
        const text = block.text.trim()
        const previous = sections.at(-1)
        if (!text || (previous?.kind === 'commentary' && previous.text === text)) {
          continue
        }
        sections.push({ kind: 'commentary', id: `${message.id}:text:${blockIndex}`, text })
        continue
      }
      if (block.type === 'tool-call') {
        const tool: RoomActivityToolStep = {
          id: `${message.id}:tool:${blockIndex}`,
          call: block,
          result: null,
          timestamp: message.timestamp,
          kind: roomActivityKindFromTool(block.name, block.input)
        }
        const previous = sections.at(-1)
        if (previous?.kind === 'tools') {
          previous.tools.push(tool)
        } else {
          sections.push({ kind: 'tools', id: `${message.id}:tools`, tools: [tool] })
        }
        pendingResults.push(tool)
        if (block.toolCallId) {
          pendingById.set(block.toolCallId, tool)
        }
        continue
      }
      if (block.type === 'tool-result') {
        let pending = block.toolCallId ? pendingById.get(block.toolCallId) : undefined
        if (!block.toolCallId) {
          while (pendingResults[resultCursor]?.call.toolCallId) {
            resultCursor += 1
          }
          pending = pendingResults[resultCursor]
        }
        if (pending) {
          pending.result = block
          if (!block.toolCallId) {
            resultCursor += 1
          }
        }
      }
    }
  }
  return sections
}

export function completedRoomActivity(
  metadata: Record<string, unknown>
): RoomCompletedActivity | null {
  const value = metadata.activity
  if (!value || typeof value !== 'object') {
    return null
  }
  const activity = value as Partial<RoomCompletedActivity>
  if (
    activity.state !== 'completed' ||
    !Number.isFinite(activity.startedAt) ||
    !Number.isFinite(activity.completedAt) ||
    !Array.isArray(activity.messages)
  ) {
    return null
  }
  return activity as RoomCompletedActivity
}

export function roomFinalFadeId(participantId: string, startedAt: number): string {
  return `room:${participantId}:${startedAt}`
}

export function formatRoomActivityDuration(startedAt: number, completedAt: number): string {
  const totalSeconds = Math.max(1, Math.round((completedAt - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', seconds ? `${seconds}s` : '']
    .filter(Boolean)
    .join(' ')
}

function compareMessages(left: NativeChatMessage, right: NativeChatMessage): number {
  return (left.timestamp ?? -1) - (right.timestamp ?? -1) || left.id.localeCompare(right.id)
}
