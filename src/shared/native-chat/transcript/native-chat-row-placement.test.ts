import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { sameNativeChatRowPlacement } from './native-chat-transcript-projection'

function row(
  id: string,
  blocks: NativeChatMessage['blocks'],
  overrides: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp: 1,
    source: 'transcript',
    journalPosition: { sequence: 1, index: 0 },
    ...overrides
  }
}

it('keeps a row in place when a save only bumps its revision and text', () => {
  const before = row('reply', [{ type: 'text', text: 'one' }], { journalRevision: 1 })
  const saved = {
    ...before,
    blocks: [{ type: 'text' as const, text: 'one two' }],
    journalRevision: 2
  }
  expect(sameNativeChatRowPlacement(before, saved)).toBe(true)
})
