import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatQuietTurns } from './native-chat-quiet-turns'

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

const WORKER: NativeChatMessage['from'] = { kind: 'agent', senders: [], orchestration: null }

describe('nativeChatQuietTurns', () => {
  it('keeps a quiet card-answer turn that a person steered a message into', () => {
    const rows = [
      row('c1', 'user', 'Card google-setup/step answered: done', { orcaNotice: 'card-answer' }),
      row('s1', 'user', 'also check my calendar'),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    const quiet = nativeChatQuietTurns(rows, ['c1', 'c1', 'c1'], new Set(['c1']), () => false)
    expect([...quiet.rows]).toEqual([])
    expect([...quiet.turns]).toEqual([])
  })

  it("hides a quiet answer to another agent's message and its turn bar, keeping the message", () => {
    const rows = [
      row('w1', 'user', 'PR is up', { from: WORKER }),
      row('a1', 'assistant', 'NO_REPLY')
    ]
    const quiet = nativeChatQuietTurns(rows, ['w1', 'w1'], new Set(['w1']), () => false)
    expect([...quiet.rows]).toEqual([1])
    expect([...quiet.turns]).toEqual(['w1'])
  })
})
