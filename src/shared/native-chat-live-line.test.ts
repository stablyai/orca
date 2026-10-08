import { describe, expect, it } from 'vitest'
import { nativeChatLiveLine } from './native-chat-live-line'
import type { NativeChatMessage } from './native-chat-types'

const prompt: NativeChatMessage = {
  id: 'user-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Start the task' }],
  timestamp: 1_000,
  source: 'transcript'
}
const open: NativeChatMessage = {
  id: 'r-1',
  role: 'reasoning',
  blocks: [{ type: 'text', text: 'Weighing two approaches' }],
  timestamp: 1_000,
  source: 'transcript',
  state: 'running'
}
const line = (fields: {
  draws?: boolean
  thinking?: boolean
  stopping?: boolean
  activityText?: string | null
}) =>
  nativeChatLiveLine({
    draws: true,
    thinking: true,
    messages: [prompt, open],
    inLiveWorkingTurn: () => true,
    ...fields
  })

describe('the live line both clients draw', () => {
  it('discloses the open block while it reads "Thinking"', () => {
    expect(line({})).toEqual({
      thinking: true,
      stopping: false,
      activityText: null,
      reasoning: { message: open, markdown: 'Weighing two approaches' }
    })
  })

  it('discloses nothing, so nothing is hidden, unless it draws and the turn is reasoning', () => {
    // A prompt the reader owes replaces the line: no line, and the row draws.
    expect(line({ draws: false })).toBeNull()
    expect(line({ thinking: false })).toEqual({
      thinking: false,
      stopping: false,
      activityText: null,
      reasoning: null
    })
  })

  // While a Stop ends the turn the line reads "Stopping…", so the open block's own row draws it.
  it('discloses no block while a Stop is ending the turn', () => {
    expect(line({ stopping: true })).toEqual({
      thinking: true,
      stopping: true,
      activityText: null,
      reasoning: null
    })
  })

  // The label may read the provider's own words; the block it discloses is still the open one.
  it('keeps the activity text it was handed', () => {
    expect(line({ activityText: 'Summarizing the plan' })).toMatchObject({
      activityText: 'Summarizing the plan',
      reasoning: { message: open }
    })
  })
})
