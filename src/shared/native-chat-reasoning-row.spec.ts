import { describe, expect, it } from 'vitest'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  nativeChatReasoningHeadlineText,
  selectNativeChatLiveReasoning
} from './native-chat-reasoning-row'
import type { NativeChatMessage } from './native-chat-types'

function row(
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  fields: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1_000,
    source: 'transcript',
    ...fields
  }
}

const prompt = row('user-1', 'user', 'Start the task')
const open = row('r-1', 'reasoning', 'Weighing two approaches', { state: 'running' })
const inTurn = (): boolean => true

describe('the open block the live line discloses', () => {
  const select = (messages: NativeChatMessage[], live: (index: number) => boolean = inTurn) =>
    selectNativeChatLiveReasoning(messages, live)?.message ?? null

  it('is the newest root reasoning row with text, with the text it has so far', () => {
    expect(selectNativeChatLiveReasoning([prompt, open], inTurn)).toEqual({
      message: open,
      markdown: 'Weighing two approaches'
    })
    // A host that keeps no lifecycle gets the same single live slot.
    const stateless = row('r-1', 'reasoning', 'Weighing two approaches')
    expect(select([prompt, stateless])).toBe(stateless)
  })

  it('is nothing when the block is blank or ended', () => {
    expect(select([prompt, row('r-1', 'reasoning', ' \n', { state: 'running' })])).toBeNull()
    expect(select([prompt, { ...open, state: 'completed' }])).toBeNull()
  })

  it('is nothing once a tool or the answer is newer than the block', () => {
    expect(select([prompt, open, row('a-1', 'assistant', 'Here it is')])).toBeNull()
    const tool = row('t-1', 'assistant', '', {
      blocks: [{ type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'running' }]
    })
    expect(select([prompt, open, tool])).toBeNull()
  })

  it('looks past notices, empty rows and rows outside the live working turn', () => {
    const notice = row('s-1', 'system', 'Compacting')
    const empty = row('a-0', 'assistant', '')
    const waiting = row('user-2', 'user', 'Also say banana')
    expect(select([prompt, open, notice, empty, waiting], (index) => index < 4)).toBe(open)
  })

  it('stops at the live turn prompt and ignores a subagent reasoning', () => {
    expect(select([open, prompt])).toBeNull()
    const child = row('r-2', 'reasoning', 'Child thinking', { state: 'running', agentId: 'sub-1' })
    expect(select([prompt, child])).toBeNull()
    expect(select([prompt, open, child])).toBe(open)
  })

  it('keys one block the same for the line and the row, apart from tool runs', () => {
    expect(nativeChatReasoningDisclosureKey('r-1')).toBe('reasoning:r-1')
  })
})

describe('the reasoning headline', () => {
  const text = (
    fields: { state?: 'running' | 'completed'; completedAt?: number },
    live = false
  ): string =>
    nativeChatReasoningHeadlineText(
      nativeChatReasoningHeadline({ timestamp: 1_000, ...fields }, { live })
    )

  it('reads the span the host saw, at least a second, and claims none it did not see', () => {
    expect(text({ state: 'completed', completedAt: 66_000 })).toBe('Thought for 1m 5s')
    expect(text({ state: 'completed', completedAt: 1_300 })).toBe('Thought for 1s')
    expect(text({ state: 'completed' })).toBe('Thought')
    expect(text({ state: 'running' })).toBe('Thought')
    expect(text({})).toBe('Reasoning')
  })

  it('claims no past tense for a block not yet ended inside its working turn', () => {
    expect(text({ state: 'running' }, true)).toBe('Reasoning')
    expect(text({}, true)).toBe('Reasoning')
    expect(text({ state: 'completed', completedAt: 13_000 }, true)).toBe('Thought for 12s')
  })
})
