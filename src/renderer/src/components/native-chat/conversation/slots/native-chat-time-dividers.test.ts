import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatTimeDividers } from './native-chat-time-dividers'

function dividers(times: (number | null)[]) {
  const messages: NativeChatMessage[] = times.map((timestamp, index) => ({
    id: String(index),
    role: 'assistant',
    source: 'transcript',
    timestamp,
    blocks: [{ type: 'text', text: 'Reply.' }]
  }))
  return [
    ...nativeChatTimeDividers(
      buildNativeChatTranscriptSlots({
        messages,
        turnKeys: messages.map((message) => message.id),
        liveTurnKey: undefined,
        receipts: new Map(),
        turnStatuses: { active: null, completedByTurn: {} },
        turnDiffs: new Map(),
        expandedTurnKeys: new Set(),
        isWorking: false,
        lifecycleWorking: false
      })
    )
  ]
}
it('places only gaps over fifteen minutes, never the first loaded message', () => {
  expect(dividers([0, 900_000, 1_800_001])).toEqual([[2, 1_800_001]])
  expect(dividers([3_600_000])).toEqual([])
})
it('ignores undated messages without losing the previous timestamp', () => {
  expect(dividers([0, null, 900_001])).toEqual([[2, 900_001]])
  expect(dividers([900_000, 0, 1])).toEqual([])
})
