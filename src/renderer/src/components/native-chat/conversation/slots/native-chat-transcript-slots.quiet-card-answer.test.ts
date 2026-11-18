import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../../../../shared/native-chat/input/questions/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

function row(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text }],
    ...extra
  }
}

const cardAnswer = (id: string) =>
  row(id, 'user', 'Card google-setup/step answered: done, client', { orcaNotice: 'card-answer' })

function drawnIds(messages: NativeChatMessage[]): string[] {
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    if (message.role === 'user') {
      turn = message.id
    }
    return turn
  })
  const settled = { startedAt: 0, thinking: false, workedSeconds: 7 }
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: {
      active: null,
      completedByTurn: Object.fromEntries(
        messages.filter((m) => m.role === 'user').map((m) => [m.id, settled])
      )
    },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false
  }).flatMap((slot) => (slot.kind === 'message' ? [slot.message.id] : []))
}

describe('a turn a hidden card answer opened', () => {
  it('draws nothing when the bot ended it with only the quiet marker', () => {
    expect(
      drawnIds([
        row('u1', 'user', 'Set up Google'),
        row('a1', 'assistant', 'Press Sign in to Google.'),
        cardAnswer('c1'),
        row('a2', 'assistant', 'NO_REPLY')
      ])
    ).toEqual(['u1', 'a1'])
  })
})
