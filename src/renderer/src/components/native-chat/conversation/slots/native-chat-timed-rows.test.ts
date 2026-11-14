import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { anchorNativeChatTimedRows } from './native-chat-timed-rows'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

const message = (id: string, timestamp: number): NativeChatMessage => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text: id }],
  timestamp,
  source: 'transcript'
})

const SLOTS = buildNativeChatTranscriptSlots({
  messages: [message('m-100', 100), message('m-200', 200)],
  turnKeys: ['m-100', 'm-200'],
  liveTurnKey: undefined,
  receipts: new Map(),
  turnStatuses: { active: null, completedByTurn: {} },
  turnDiffs: new Map(),
  expandedTurnKeys: new Set(),
  isWorking: false,
  lifecycleWorking: false
})
const ROWS = [
  { key: 'old', at: 50, node: null },
  { key: 'mid', at: 150, node: null }
]

describe('anchorNativeChatTimedRows', () => {
  it('holds back a row older than every loaded message instead of drawing it last', () => {
    expect(anchorNativeChatTimedRows(SLOTS, ROWS)).toEqual([['mid', 'm-100']])
  })
})
