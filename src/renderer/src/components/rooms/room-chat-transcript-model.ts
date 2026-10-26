import type { RoomLine } from './room-types'
import { roomMentionsIn } from '../../../../shared/orchestration-room-mentions'

export type RoomChatEntry = {
  line: RoomLine
  isFirstInSegment: boolean
}

export type RoomChatSegment = {
  key: string
  speakerKey: string
  who: string
  memberId: string | null
  isUser: boolean
  entries: RoomChatEntry[]
}

const ROOM_TOOL_BLOCK = /```orca-room-tool\s*[\s\S]*?```/g

/** Admin tool syntax is transport, not conversation. */
export function stripRoomToolBlocks(text: string): string {
  return text.replace(ROOM_TOOL_BLOCK, '').trim()
}

/** A member view is a lens over the shared room log, not another transcript source. */
export function selectRoomMemberChatLines(
  lines: readonly RoomLine[],
  member: { memberId: string; name: string }
): RoomLine[] {
  return lines.filter((line) => {
    if (line.memberId === member.memberId || line.targetMemberId === member.memberId) {
      return true
    }
    // Legacy lines predate explicit targets; use the same mention rule as the host.
    return (
      !line.memberId &&
      roomMentionsIn(line.text, [{ id: member.memberId, name: member.name }]).found.length > 0
    )
  })
}

/** Consecutive messages from one speaker read as one ds_bot-style turn. */
export function buildRoomChatSegments(lines: readonly RoomLine[]): RoomChatSegment[] {
  const segments: RoomChatSegment[] = []
  for (const line of lines) {
    const speakerKey = line.memberId ?? `user:${line.who}`
    const last = segments.at(-1)
    if (last?.speakerKey === speakerKey) {
      last.entries.push({ line, isFirstInSegment: false })
      continue
    }
    segments.push({
      key: `segment-${line.seq}`,
      speakerKey,
      who: line.who,
      memberId: line.memberId,
      isUser: !line.memberId,
      entries: [{ line, isFirstInSegment: true }]
    })
  }
  return segments
}
