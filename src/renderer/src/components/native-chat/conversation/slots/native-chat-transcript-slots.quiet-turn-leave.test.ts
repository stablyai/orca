import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

const WORKER: NativeChatMessage['from'] = { kind: 'agent', senders: [], orchestration: null }
const at = (
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }],
  ...extra
})
const note: NativeChatMessage = {
  ...at('n1', 'system', ''),
  blocks: [],
  botItemNote: {
    noteId: 'n1',
    by: 'bot',
    entries: [
      { uid: 'i', number: 1, title: 'Export', status: 'working', event: 'commented', text: 'Yes.' }
    ]
  }
}
const messages = [
  at('w1', 'user', 'repro found', { from: WORKER }),
  note,
  at('a1', 'assistant', 'NO_REPLY')
]

function drawn(leavingTurnKeys?: ReadonlySet<string>) {
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: ['w1', 'w1', 'w1'],
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: {
      active: null,
      completedByTurn: { w1: { startedAt: 0, thinking: false, workedSeconds: 9 } }
    },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false,
    leavingTurnKeys
  }).flatMap((slot) =>
    slot.kind === 'message'
      ? [[slot.message.id, slot.status !== undefined, slot.leaving ?? null]]
      : []
  )
}

describe('a quiet turn in the transcript', () => {
  it('draws the bar and answer during the fade, then keeps only the mail and item note', () => {
    expect(drawn(new Set(['w1']))).toEqual([
      ['w1', true, 'bar'],
      ['n1', false, null],
      ['a1', false, 'row']
    ])
    expect(drawn()).toEqual([
      ['w1', false, null],
      ['n1', false, null]
    ])
  })
})
