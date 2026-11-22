import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscript } from './native-chat-transcript-slots'
import { withStreamedRows } from './native-chat-transcript-streamed-slots'

const message = (id: string, role: 'user' | 'assistant', text: string): NativeChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript'
})

function transcript(rows: readonly NativeChatMessage[]) {
  return buildNativeChatTranscript({
    messages: rows,
    turnKeys: rows.map((_, index) => `turn-${Math.floor(index / 2)}`),
    liveTurnKey: `turn-${Math.floor((rows.length - 1) / 2)}`,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: true,
    lifecycleWorking: true
  })
}

// Perf contract: a live window that only grows a reply keeps every other slot as built, so the
// transcript is not rebuilt across its whole history; the reply's slot carries its newest text.
it('swaps only the streaming row into slots built from the saved rows', () => {
  const saved: NativeChatMessage[] = []
  for (let turn = 0; turn < 200; turn++) {
    saved.push(message(`ask-${turn}`, 'user', `Question ${turn}`))
    saved.push(message(`answer-${turn}`, 'assistant', `Answer ${turn}`))
  }
  const { slots } = transcript(saved)
  const current = saved.slice()
  current[current.length - 1] = message('answer-199', 'assistant', 'Answer 199, and more of it')
  const streamed = withStreamedRows(slots, saved, current)!
  expect(streamed.filter((slot, index) => slot !== slots[index])).toHaveLength(1)
  expect(streamed.at(-1)).toMatchObject({
    kind: 'message',
    message: { blocks: [{ text: 'Answer 199, and more of it' }] }
  })
  expect(streamed.map(({ kind, ...rest }) => ({ kind, ...rest, message: undefined }))).toEqual(
    transcript(current).slots.map(({ kind, ...rest }) => ({ kind, ...rest, message: undefined }))
  )

  // A reply's first words change what its slot draws, so the transcript is built again.
  const empty = saved.slice()
  empty[empty.length - 1] = message('answer-199', 'assistant', '')
  expect(withStreamedRows(transcript(empty).slots, empty, current)).toBeNull()
})
