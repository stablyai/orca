import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import { roomActivityKindFromTool } from '../../../../shared/room-activity'
import type { RoomActivityKind, RoomSettledActivity } from '../../../../shared/rooms'
import { visibleRoomReplyText } from '../native-chat/native-chat-room-transport'
import { codexSubagentProviderFrame } from '../../../../shared/codex-subagent-items'

export type RoomActivityToolStep = {
  id: string
  call: NativeChatToolCallBlock
  result: NativeChatToolResultBlock | null
  timestamp: number | null
  kind: RoomActivityKind
}

export type RoomActivitySection =
  | { kind: 'commentary'; id: string; text: string }
  | { kind: 'diagnostic'; id: string; block: NativeChatBlock }
  | { kind: 'tools'; id: string; tools: RoomActivityToolStep[] }

export function buildRoomActivitySections(messages: NativeChatMessage[]): RoomActivitySection[] {
  const sections: RoomActivitySection[] = []
  const pendingResults: RoomActivityToolStep[] = []
  const pendingById = new Map<string, RoomActivityToolStep>()
  let resultCursor = 0

  for (const message of messages) {
    for (const [blockIndex, original] of message.blocks.entries()) {
      const event =
        original.type === 'text' && original.providerFrame
          ? codexSubagentProviderFrame(original.providerFrame)
          : null
      const block = event
        ? { type: 'tool-call' as const, name: event.name, input: event.input, state: event.state }
        : original
      if (block.type === 'text' && block.providerFrame) {
        sections.push({ kind: 'diagnostic', id: `${message.id}:diagnostic:${blockIndex}`, block })
        continue
      }
      if (block.type === 'text') {
        if (message.role === 'user') {
          continue
        }
        if (message.role !== 'assistant' && message.role !== 'reasoning') {
          continue
        }
        const text =
          message.role === 'assistant' ? visibleRoomReplyText(block.text).trim() : block.text.trim()
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

export function settledRoomActivity(metadata: Record<string, unknown>): RoomSettledActivity | null {
  const value = metadata.activity
  if (!value || typeof value !== 'object') {
    return null
  }
  const activity = value as Partial<RoomSettledActivity>
  if (
    (activity.state !== 'completed' && activity.state !== 'interrupted') ||
    !Number.isFinite(activity.startedAt) ||
    !Number.isFinite(activity.completedAt) ||
    !Array.isArray(activity.messages)
  ) {
    return null
  }
  return {
    ...(activity as RoomSettledActivity),
    messages: activity.messages.filter(
      (message) =>
        message.timestamp === null ||
        (Number.isFinite(message.timestamp) &&
          message.timestamp >= activity.startedAt! &&
          message.timestamp <= activity.completedAt!)
    )
  }
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
