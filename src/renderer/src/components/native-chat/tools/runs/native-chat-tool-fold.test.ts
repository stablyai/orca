import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

import { foldToolMessages } from '../../../../../../shared/native-chat/tools/native-chat-tool-fold'

function msg(
  overrides: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id'>
): NativeChatMessage {
  return {
    role: 'assistant',
    blocks: [],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

describe('foldToolMessages', () => {
  it('drops a result after a user turn abandons the pending call', () => {
    const folded = foldToolMessages([
      msg({ id: 'c', role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: {} }] }),
      msg({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'stop' }] }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'x' }] })
    ])
    expect(folded.map((m) => m.id)).toEqual(['c', 'u'])
  })

  it('attributes a Claude tool result carried with a harness sidecar', () => {
    const folded = foldToolMessages([
      msg({
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      }),
      msg({
        id: 'u',
        role: 'user',
        blocks: [
          { type: 'tool-result', output: 'important output' },
          { type: 'text', text: '<system-reminder>continue</system-reminder>' }
        ]
      })
    ])

    expect(folded).toEqual([
      expect.objectContaining({
        id: 'a',
        blocks: [
          { type: 'tool-call', name: 'Read', input: {} },
          { type: 'tool-result', output: 'important output' }
        ]
      }),
      expect.objectContaining({
        id: 'u',
        blocks: [{ type: 'text', text: '<system-reminder>continue</system-reminder>' }]
      })
    ])
  })

  it('does not traverse an interruption sidecar carrying a stale result', () => {
    const folded = foldToolMessages([
      msg({
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      }),
      msg({
        id: 'i',
        role: 'user',
        blocks: [
          { type: 'tool-result', output: 'stale' },
          { type: 'text', text: '[Request interrupted by user]' }
        ]
      })
    ])

    expect(folded).toEqual([
      expect.objectContaining({
        id: 'a',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      }),
      expect.objectContaining({
        id: 'i',
        blocks: [{ type: 'text', text: '[Request interrupted by user]' }]
      })
    ])
  })
})
