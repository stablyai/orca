import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../../shared/native-chat/input/questions/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { buildNativeChatTranscriptSlots } from './conversation/slots/native-chat-transcript-slots'
import { buildNativeChatRailItems } from './viewport/rail/native-chat-message-rail-items'

function text(id: string, body: string, role: NativeChatMessage['role'] = 'assistant') {
  return {
    id,
    role,
    blocks: [{ type: 'text' as const, text: body }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function slotsOf(messages: NativeChatMessage[]) {
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    if (message.role === 'user') {
      turn = message.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false
  })
}

describe('rail items', () => {
  it("skips Orca's first turn to a new bot, which no one typed", () => {
    const kickoff = {
      ...text('k', 'Orca: you were just created.', 'user'),
      orcaNotice: 'bot-created' as const
    }
    const items = buildNativeChatRailItems(
      slotsOf([kickoff, text('a1', 'hi'), text('u1', 'ask', 'user')])
    )
    expect(items.map((item) => item.id)).toEqual(['u1'])
  })

  // Invisible messages consume no slot, so rail navigation must use virtualizer indexes rather than message positions.
})
