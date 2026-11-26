import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatNewRowsMarkerPlacement } from '../../viewport/new-rows/native-chat-new-rows-marker'

it('keeps the unread divider at the first missed reply when a recorded row folded away', () => {
  const messages: NativeChatMessage[] = ['user', 'user', 'assistant'].map((role, index) => ({
    id: String(index),
    role: role === 'assistant' ? 'assistant' : 'user',
    source: 'transcript',
    timestamp: index,
    journalPosition: { sequence: index, index: 0 },
    blocks: [{ type: 'text', text: 'Message.' }]
  }))
  const slots = buildNativeChatTranscriptSlots({
    messages,
    turnKeys: ['0', '1', '1'],
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
  expect(
    nativeChatNewRowsMarkerPlacement(slots, {
      key: 'folded-away',
      after: { sequence: 0, index: 0 },
      through: { sequence: 2, index: 0 }
    })
  ).toEqual({ key: '2', place: 'above-row' })
  expect(nativeChatNewRowsMarkerPlacement(slots, null)).toBeUndefined()
  expect(
    nativeChatNewRowsMarkerPlacement(slots, {
      key: 'gone',
      after: { sequence: 9, index: 0 },
      through: { sequence: 10, index: 0 }
    })
  ).toBeUndefined()
})
